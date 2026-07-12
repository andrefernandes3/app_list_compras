const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// 1. FUNÇÃO: MENOR PREÇO HISTÓRICO
// ============================================================================
async function obterMenorPrecoHistorico(db, nomeProduto) {
    const historico = await db.collection('historico_precos').find({ nome: nomeProduto }).toArray();
    if (historico.length === 0) return Infinity;
    return Math.min(...historico.map(h => h.preco));
}

// ============================================================================
// 2. FUNÇÃO AUXILIAR DE REQUISIÇÃO (Blindada contra erros e redirecionamentos)
// ============================================================================
const buscarDadosVtex = (targetUrl) => {
    return new Promise((resolve) => {
        const urlObj = new URL(targetUrl);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        };

        const reqHttp = https.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let novaUrl = res.headers.location;
                if (novaUrl.startsWith('/')) novaUrl = `https://${urlObj.hostname}${novaUrl}`;
                return resolve(buscarDadosVtex(novaUrl));
            }
            if (res.statusCode !== 200) return resolve(null);

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } 
                catch (e) { resolve(null); }
            });
        });

        reqHttp.on('error', () => resolve(null));
        reqHttp.end();
    });
};

// ============================================================================
// 3. FUNÇÃO PRINCIPAL
// ============================================================================
module.exports = async function (context, req) {
    const configs = [
        { id: 'SAMS', nome: "Sam's Club", host: 'https://www.samsclub.com.br', regionId: '', sc: '1' },
        { id: 'CARREFOUR', nome: "Carrefour", host: 'https://www.carrefour.com.br', regionId: '', sc: '1' },
        { 
            id: 'ATACADAO', 
            nome: "Atacadão", 
            host: 'https://www.atacadao.com.br', 
            regionId: 'v2.8CB7CC2FFB5F56CD19FB23952C3277A6',
            sc: '1'
        }
    ];

    let client = null;
    let relatorio = [];

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        const dicionarioCol = db.collection('dicionario_produtos');
        const alertasCol = db.collection('alertas_preco');
        
        const monitorados = await dicionarioCol.find({ monitorar: true }).toArray();

        if (monitorados.length === 0) {
            context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { aviso: "Nenhum produto marcado para monitorar." } };
            return;
        }

        for (const prod of monitorados) {
            if (!prod.ean) {
                relatorio.push({ produto: prod.nome_comum, status: "IGNORADO - SEM CÓDIGO EAN" });
                continue; 
            }

            const precoReferencia = prod.preco_alvo || await obterMenorPrecoHistorico(db, prod.nome_comum);
            const temAlvo = precoReferencia !== Infinity;

            // Busca nas 3 lojas simultaneamente
            const promessasBusca = configs.map(async (lojaConfig) => {
                try {
                    let urlEan = `${lojaConfig.host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${prod.ean}&sc=${lojaConfig.sc}&_=${Date.now()}`;
                    if (lojaConfig.regionId) urlEan += `&regionId=${lojaConfig.regionId}`;
                    
                    const data = await buscarDadosVtex(urlEan);

                    if (data && data.length > 0) {
                        const item = data[0];
                        let precoAtual = 0;
                        let linkCompra = item.link;
                        let nomeLojaOrigem = "N/A";

                        // Loop seguro para achar o primeiro seller com estoque (Sua lógica original)
                        for (const seller of item.items[0].sellers) {
                            if (seller.commertialOffer.Price > 0) {
                                precoAtual = seller.commertialOffer.Price;
                                nomeLojaOrigem = seller.sellerName;
                                break; 
                            }
                        }

                        return {
                            produto: prod.nome_comum,
                            loja: lojaConfig.nome,
                            origem: nomeLojaOrigem,
                            link: linkCompra,
                            status: precoAtual > 0 ? "ENCONTRADO" : "SEM ESTOQUE (Preço 0,00)",
                            preco: precoAtual
                        };
                    } else {
                        return { produto: prod.nome_comum, loja: lojaConfig.nome, origem: "N/A", status: "NÃO ENCONTRADO NO CATÁLOGO", preco: 0 };
                    }
                } catch (err) {
                    return { produto: prod.nome_comum, loja: lojaConfig.nome, origem: "ERRO", status: "ERRO DE CONEXÃO", preco: 0 };
                }
            });

            const resultadosDoProduto = await Promise.all(promessasBusca);
            
            // Processa o resultado e gera os alertas
            for (const res of resultadosDoProduto) {
                relatorio.push({
                    produto: res.produto,
                    loja: res.loja,
                    origem: res.origem,
                    status: res.status,
                    ...(res.preco > 0 && { preco: res.preco })
                });

                // A sua lógica original de disparo de alertas
                if (res.status === "ENCONTRADO" && temAlvo && res.preco < precoReferencia) {
                    const jaExiste = await alertasCol.findOne({
                        produto_nome: res.produto, 
                        loja: res.loja, 
                        preco_atual: res.preco, 
                        status_notificacao: "pendente"
                    });
                    
                    if (!jaExiste) {
                        await alertasCol.insertOne({
                            produto_nome: res.produto, 
                            loja: res.loja, 
                            preco_historico: precoReferencia,
                            preco_atual: res.preco, 
                            link_compra: res.link, 
                            data_alerta: new Date(), 
                            status_notificacao: "pendente"
                        });
                    }
                }
            }
        }

        context.res = { 
            status: 200, 
            headers: { "Content-Type": "application/json" },
            body: relatorio 
        };
        
    } catch (e) {
        context.res = { status: 500, headers: { "Content-Type": "application/json" }, body: { erro: "Erro Crítico: " + e.message } };
    } finally {
        if (client) await client.close();
    }
};