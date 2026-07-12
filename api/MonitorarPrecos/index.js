const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// 1. CONFIGURAÇÕES DAS LOJAS E REGIÕES (SC - Sales Channel)
// ============================================================================
const configs = [
    { 
        id: 'SAMS', 
        nome: "Sam's Club", 
        host: 'https://www.samsclub.com.br', 
        // sc: '1' -> Padrão Nacional. Para forçar Osasco, coloque o número correspondente (ex: sc: '3')
        sc: '1' 
    },
    { 
        id: 'CARREFOUR', 
        nome: "Carrefour", 
        host: 'https://www.carrefour.com.br', 
        sc: '1' 
    },
    { 
        id: 'ATACADAO', 
        nome: "Atacadão", 
        host: 'https://www.atacadao.com.br', 
        sc: '1' 
    }
];

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
            // Segue redirecionamentos (301/302)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let novaUrl = res.headers.location;
                if (novaUrl.startsWith('/')) novaUrl = `https://${urlObj.hostname}${novaUrl}`;
                return resolve(buscarDadosVtex(novaUrl));
            }

            // Ignora erros de bloqueio e retorna null silenciosamente
            if (res.statusCode !== 200) {
                return resolve(null);
            }

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
// 3. FUNÇÃO PRINCIPAL (Loop, Processamento e Gravação no Banco)
// ============================================================================
module.exports = async function (context, req) {
    let client = null;
    let relatorio = [];

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        
        // Traz do banco APENAS os itens que devem ser monitorados e que possuem EAN válido
        const monitorados = await db.collection('dicionario_produtos')
            .find({ monitorar: true, ean: { $exists: true, $ne: "" } })
            .toArray();

        const dataAtual = new Date(); // Data padrão para as inserções no banco

        for (const prod of monitorados) {
            
            // Dispara a busca nas 3 lojas SIMULTANEAMENTE (Ganho enorme de performance)
            const promessasBusca = configs.map(async (lojaConfig) => {
                try {
                    const urlEan = `${lojaConfig.host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${prod.ean}&sc=${lojaConfig.sc}&_=${Date.now()}`;
                    
                    const data = await buscarDadosVtex(urlEan);

                    if (data && data.length > 0) {
                        const item = data[0];
                        const sellerAtivo = item.items[0].sellers[0];
                        
                        const precoAtual = sellerAtivo.commertialOffer.Price;
                        const nomeLojaOrigem = sellerAtivo.sellerName; 

                        return {
                            ean: prod.ean,
                            produto: prod.nome_comum,
                            loja: lojaConfig.nome,
                            origem: nomeLojaOrigem, 
                            status: precoAtual > 0 ? "ENCONTRADO" : "SEM ESTOQUE",
                            preco: precoAtual > 0 ? precoAtual : 0
                        };
                    } else {
                        return { 
                            ean: prod.ean,
                            produto: prod.nome_comum, 
                            loja: lojaConfig.nome, 
                            origem: "N/A", 
                            status: "NÃO ENCONTRADO",
                            preco: 0
                        };
                    }
                } catch (err) {
                    return { ean: prod.ean, produto: prod.nome_comum, loja: lojaConfig.nome, origem: "ERRO", status: "ERRO", preco: 0 };
                }
            });

            // Aguarda a resposta das 3 lojas para este produto antes de prosseguir
            const resultadosDoProduto = await Promise.all(promessasBusca);
            relatorio.push(...resultadosDoProduto);

            // ================================================================
            // SALVA NO BANCO DE DADOS PARA A API DE ALERTAS FUNCIONAR
            // ================================================================
            for (const res of resultadosDoProduto) {
                // Só atualiza o banco se o produto realmente tem um preço válido na loja
                if (res.status === "ENCONTRADO" && res.preco > 0) {
                    
                    // 1. Atualiza a tabela temporária (Geralmente usada para comparar com o preço anterior no alerta)
                    await db.collection('precos_temp').updateOne(
                        { ean: res.ean, loja: res.loja },
                        { 
                            $set: { 
                                ean: res.ean,
                                produto: res.produto,
                                loja: res.loja,
                                origem: res.origem,
                                preco: res.preco,
                                data_verificacao: dataAtual
                            } 
                        },
                        { upsert: true }
                    );

                    // 2. Grava um registro no histórico de preços (para gerar gráficos/histórico)
                    await db.collection('historico_precos').insertOne({
                        ean: res.ean,
                        produto: res.produto,
                        loja: res.loja,
                        origem: res.origem,
                        preco: res.preco,
                        data_verificacao: dataAtual
                    });
                }
            }
        }

        context.res = { 
            status: 200, 
            headers: { "Content-Type": "application/json" },
            body: relatorio 
        };
        
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};