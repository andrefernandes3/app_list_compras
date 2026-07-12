const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// 1. BUSCAR ÚLTIMO PREÇO HISTÓRICO
// ============================================================================
async function obterUltimoPrecoValido(db, nomeProduto, nomeLoja) {
    const ultimoRegistro = await db.collection('historico_precos_web')
        .find({ nome: nomeProduto, loja: nomeLoja, preco: { $gt: 0 } })
        .sort({ data_verificacao: -1 })
        .limit(1)
        .toArray();
    return ultimoRegistro.length === 0 ? Infinity : ultimoRegistro[0].preco;
}

// ============================================================================
// 2. REQUISIÇÃO HTTPS (com logs)
// ============================================================================
const buscarDadosVtex = async (targetUrl, context) => {
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

        context.log(`[REQUEST] ${targetUrl}`);
        const reqHttp = https.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let novaUrl = res.headers.location;
                if (novaUrl.startsWith('/')) novaUrl = `https://${urlObj.hostname}${novaUrl}`;
                return resolve(buscarDadosVtex(novaUrl, context));
            }
            if (res.statusCode !== 200) {
                context.log(`[RESPONSE] status ${res.statusCode} - não OK`);
                return resolve(null);
            }

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    context.log(`[RESPONSE] tamanho: ${json.length} itens`);
                    resolve(json);
                } catch (e) {
                    context.log(`[RESPONSE] erro ao parsear JSON: ${e.message}`);
                    resolve(null);
                }
            });
        });

        reqHttp.on('error', (e) => {
            context.log(`[ERRO] ${e.message}`);
            resolve(null);
        });
        reqHttp.end();
    });
};

// ============================================================================
// 3. FUNÇÃO PRINCIPAL – CARREFOUR APENAS
// ============================================================================
module.exports = async function (context, req) {
    // Configuração do Carrefour
    const lojaConfig = {
        id: 'CARREFOUR',
        nome: "Carrefour",
        host: 'https://www.carrefour.com.br',
        regionId: '',   // ← se você descobrir um valor fixo, coloque aqui (ex: 'v2.xxxx')
        sc: '1'
    };

    let client = null;
    let relatorio = [];

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        const dicionarioCol = db.collection('dicionario_produtos');
        const alertasCol = db.collection('alertas_preco');

        const monitorados = await dicionarioCol.find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();
        if (monitorados.length === 0) {
            context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        for (const prod of monitorados) {
            context.log(`\n=== Processando: ${prod.nome_comum} (EAN: ${prod.ean}) ===`);

            // 1. Último preço web e referência
            const ultimoPrecoWeb = await obterUltimoPrecoValido(db, prod.nome_comum, lojaConfig.nome);
            const precoReferencia = prod.preco_alvo || ultimoPrecoWeb;
            const temAlvo = precoReferencia !== Infinity;

            let resultado = null;

            // 2. Tenta buscar por EAN em vários campos
            const camposEAN = ['alternateIds_Ean', 'ean', 'alternateIds_ean'];
            let dados = null;
            for (const campo of camposEAN) {
                let url = `${lojaConfig.host}/api/catalog_system/pub/products/search?fq=${campo}:${prod.ean}&sc=${lojaConfig.sc}&_=${Date.now()}`;
                if (lojaConfig.regionId) url += `&regionId=${lojaConfig.regionId}`;
                dados = await buscarDadosVtex(url, context);
                if (dados && dados.length > 0) break;
            }

            // 3. Se não encontrou por EAN, tenta busca por nome (fallback)
            if (!dados || dados.length === 0) {
                context.log(`[FALLBACK] Buscando por nome do produto: ${prod.nome_comum}`);
                const nomeCodificado = encodeURIComponent(prod.nome_comum);
                let urlNome = `${lojaConfig.host}/api/catalog_system/pub/products/search?q=${nomeCodificado}&sc=${lojaConfig.sc}&_=${Date.now()}`;
                if (lojaConfig.regionId) urlNome += `&regionId=${lojaConfig.regionId}`;
                dados = await buscarDadosVtex(urlNome, context);
                // Se houver múltiplos, tenta encontrar o que tem o nome mais parecido (opcional)
                if (dados && dados.length > 0) {
                    // Filtra os que têm EAN (se vier) ou escolhe o primeiro
                    // Aqui você pode implementar uma lógica de similaridade
                    const produtoEncontrado = dados.find(item => 
                        item.productName && item.productName.toLowerCase().includes(prod.nome_comum.toLowerCase())
                    ) || dados[0];
                    dados = [produtoEncontrado];
                }
            }

            if (dados && dados.length > 0) {
                const item = dados[0];
                let precoAtual = 0;
                let linkCompra = item.link;
                let nomeLojaOrigem = "N/A";

                if (item.items && item.items.length > 0) {
                    for (const seller of item.items[0].sellers) {
                        if (seller.commertialOffer && seller.commertialOffer.Price > 0) {
                            precoAtual = seller.commertialOffer.Price;
                            nomeLojaOrigem = seller.sellerName || "N/A";
                            break;
                        }
                    }
                }

                resultado = {
                    produto: prod.nome_comum,
                    loja: lojaConfig.nome,
                    origem: nomeLojaOrigem,
                    link: linkCompra,
                    status: precoAtual > 0 ? "ENCONTRADO" : "SEM ESTOQUE (Preço 0,00)",
                    preco: precoAtual,
                    precoReferencia,
                    ultimoPrecoWeb,
                    temAlvo
                };
            } else {
                resultado = {
                    produto: prod.nome_comum,
                    loja: lojaConfig.nome,
                    origem: "N/A",
                    status: "NÃO ENCONTRADO",
                    preco: 0
                };
                context.log(`[FINAL] Produto NÃO ENCONTRADO`);
            }

            // 4. Adiciona ao relatório e processa alertas
            relatorio.push({
                produto: resultado.produto,
                loja: resultado.loja,
                origem: resultado.origem,
                status: resultado.status,
                ...(resultado.preco > 0 && { preco: resultado.preco, referencia_usada: resultado.precoReferencia })
            });

            if (resultado.status === "ENCONTRADO" && resultado.preco > 0) {
                // Alerta se preço caiu
                if (resultado.temAlvo && resultado.preco < resultado.precoReferencia) {
                    const jaExiste = await alertasCol.findOne({
                        produto_nome: resultado.produto,
                        loja: resultado.loja,
                        preco_atual: resultado.preco,
                        status_notificacao: "pendente"
                    });
                    if (!jaExiste) {
                        await alertasCol.insertOne({
                            produto_nome: resultado.produto,
                            loja: resultado.loja,
                            preco_historico: resultado.precoReferencia,
                            preco_atual: resultado.preco,
                            link_compra: resultado.link,
                            data_alerta: new Date(),
                            status_notificacao: "pendente"
                        });
                    }
                }
                // Salva histórico se mudou
                if (resultado.preco !== resultado.ultimoPrecoWeb) {
                    await db.collection('historico_precos_web').insertOne({
                        nome: resultado.produto,
                        ean: prod.ean,
                        loja: resultado.loja,
                        origem: resultado.origem,
                        preco: resultado.preco,
                        data_verificacao: new Date()
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
        context.res = {
            status: 500,
            headers: { "Content-Type": "application/json" },
            body: { erro: "Erro Crítico: " + e.message }
        };
    } finally {
        if (client) await client.close();
    }
};