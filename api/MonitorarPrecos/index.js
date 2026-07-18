const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// CONFIGURAÇÕES GERAIS
// ============================================================================
const CEP_PADRAO = process.env.CEP_PADRAO || '06093085';
const TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

// ============================================================================
// LISTA DE SELLERS PARA CADA LOJA (prioridade)
// ============================================================================
const SELLERS_ATACADAO = [
    'atacadaobr637',
    'atacadaobr634',
    'atacadaobr649',
    'atacadaobr680',
    'atacadaobr697',
    'atacadaobr698',
    'atacadaobr938',
    'atacadaobr939'
];

// Para Sam's Club, podemos definir sellers comuns (se houver)
// Inicialmente, vamos usar seller padrão '1' e tentar outros se necessário
const SELLERS_SAMS = ['1', '2', '3']; // valores genéricos; ajustar conforme descoberta

// ============================================================================
// FUNÇÕES AUXILIARES (buscarDadosVtex melhorada com timeout e retry)
// ============================================================================
function buscarDadosVtex(targetUrl, tentativa = 1) {
    return new Promise((resolve) => {
        const urlObj = new URL(targetUrl);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            },
            timeout: TIMEOUT_MS
        };

        const reqHttp = https.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let novaUrl = res.headers.location;
                if (novaUrl.startsWith('/')) novaUrl = `https://${urlObj.hostname}${novaUrl}`;
                return resolve(buscarDadosVtex(novaUrl, tentativa));
            }
            if (res.statusCode !== 200) {
                if (tentativa < MAX_RETRIES) {
                    setTimeout(() => resolve(buscarDadosVtex(targetUrl, tentativa + 1)), 1000);
                } else {
                    resolve(null);
                }
                return;
            }

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { resolve(null); }
            });
        });

        reqHttp.on('error', () => {
            if (tentativa < MAX_RETRIES) {
                setTimeout(() => resolve(buscarDadosVtex(targetUrl, tentativa + 1)), 1000);
            } else {
                resolve(null);
            }
        });
        reqHttp.end();
    });
}

// ============================================================================
// FUNÇÃO: OBTER REGIONID DINAMICAMENTE (para lojas que usam)
// ============================================================================
async function obterRegionId(host, cep) {
    try {
        const url = `${host}/api/checkout/pub/regions?country=BRA&postalCode=${cep}`;
        const data = await buscarDadosVtex(url);
        if (data && data.length > 0) {
            const region = data.find(r => r.id && r.id.startsWith('v2.'));
            return region ? region.id : data[0].id;
        }
    } catch (e) {
        console.warn(`Falha ao obter regionId para ${host}:`, e.message);
    }
    return null;
}

// ============================================================================
// FUNÇÃO: EXTRAIR INFORMAÇÕES BÁSICAS DO PRODUTO (SKU, linkText)
// ============================================================================
function extrairInfoProduto(data) {
    if (!data || data.length === 0) return null;
    const item = data[0];
    if (!item.items || item.items.length === 0) return null;
    const variant = item.items[0];
    return {
        sku: variant.itemId,
        linkText: item.linkText,
        link: item.link || `https://${new URL(item.link).hostname}/${item.linkText}/p`,
        name: item.productName
    };
}

// ============================================================================
// FUNÇÃO: EXTRAIR PREÇO DIRETO DA RESPOSTA DA API (para fallback)
// ============================================================================
function extrairPrecoDireto(dados) {
    if (!dados || dados.length === 0) return null;
    for (const item of dados) {
        if (!item.items) continue;
        for (const variant of item.items) {
            if (!variant.sellers) continue;
            for (const seller of variant.sellers) {
                const offer = seller.commertialOffer;
                if (offer && offer.Price > 0) {
                    return {
                        preco: offer.Price,
                        nomeLojaOrigem: seller.sellerName || 'Loja',
                        sku: variant.itemId,
                        seller: seller.sellerId
                    };
                }
            }
        }
    }
    return null;
}

// ============================================================================
// FUNÇÃO: SIMULAR CARRINHO (para obter preço com seller específico)
// ============================================================================
async function simularCarrinho(host, regionId, sku, sellerId, sc = 1) {
    const url = `${host}/api/checkout/pub/orderForms/simulation?sc=${sc}`;
    const payload = {
        items: [{ id: sku, quantity: 1, seller: sellerId }],
        regionId: regionId,
        country: 'BRA'
    };

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
        },
        timeout: TIMEOUT_MS
    };

    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const req = https.request({
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: options.headers,
            timeout: options.timeout
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.items && json.items.length > 0) {
                        const item = json.items[0];
                        if (item.price > 0 && item.availability === 'available') {
                            resolve({
                                preco: item.price / 100,
                                seller: item.seller,
                                available: true
                            });
                            return;
                        }
                    }
                    resolve(null);
                } catch {
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(JSON.stringify(payload));
        req.end();
    });
}

// ============================================================================
// FUNÇÃO: BUSCAR PRODUTO COM ESTRATÉGIA POR LOJA (unificada)
// ============================================================================
async function buscarProduto(lojaConfig, ean, produtoNome, regionId) {
    const { host, nome, scList = [1], sellers = ['1'], useSimulationFallback = false } = lojaConfig;
    let resultado = null;

    // Tenta cada sc
    for (const sc of scList) {
        // 1. Busca por EAN
        let url = `${host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}&sc=${sc}`;
        if (lojaConfig.regionId) url += `&regionId=${lojaConfig.regionId}`;
        url += `&_=${Date.now()}`;

        let dados = await buscarDadosVtex(url);
        let sku = null, link = null, linkText = null;

        if (dados && dados.length > 0) {
            const info = extrairInfoProduto(dados);
            if (info) {
                sku = info.sku;
                link = info.link;
                linkText = info.linkText;
                // Tenta extrair preço direto (pode funcionar para alguns sellers)
                const precoDireto = extrairPrecoDireto(dados);
                if (precoDireto) {
                    return { ...precoDireto, link };
                }
            }
        }

        // Se não encontrou SKU, tenta buscar por nome (fallback)
        if (!sku) {
            const urlNome = `${host}/api/catalog_system/pub/products/search?fq=productName:${encodeURIComponent(produtoNome)}&sc=${sc}`;
            if (lojaConfig.regionId) urlNome += `&regionId=${lojaConfig.regionId}`;
            urlNome += `&_=${Date.now()}`;
            dados = await buscarDadosVtex(urlNome);
            if (dados && dados.length > 0) {
                const info = extrairInfoProduto(dados);
                if (info) {
                    sku = info.sku;
                    link = info.link;
                    linkText = info.linkText;
                }
            }
        }

        // Se tem SKU e a loja permite simulação, tenta com sellers
        if (sku && useSimulationFallback && lojaConfig.regionId) {
            for (const seller of sellers) {
                const sim = await simularCarrinho(host, lojaConfig.regionId, sku, seller, sc);
                if (sim && sim.preco > 0) {
                    return {
                        preco: sim.preco,
                        nomeLojaOrigem: `${nome} (${seller})`,
                        sku: sku,
                        link: link || `https://${new URL(host).hostname}/${linkText}/p`,
                        seller: seller
                    };
                }
            }
        }

        // Se não encontrou com simulação, mas tem SKU, pode tentar novamente com outro sc
    }

    return null; // não encontrado
}

// ============================================================================
// FUNÇÃO PRINCIPAL
// ============================================================================
module.exports = async function (context, req) {
    // Configuração das lojas com estratégias específicas
    const configs = [
        {
            id: 'SAMS',
            nome: "Sam's Club",
            host: 'https://www.samsclub.com.br',
            regionId: null, // será obtido dinamicamente se possível
            scList: [1, 2, 3], // tentar múltiplos
            sellers: ['1', '2', '3'], // sellers a testar na simulação
            useSimulationFallback: true
        },
        {
            id: 'CARREFOUR',
            nome: "Carrefour",
            host: 'https://www.carrefour.com.br',
            regionId: null,
            scList: [1, 2],
            sellers: ['1', '2'],
            useSimulationFallback: true
        },
        {
            id: 'ATACADAO',
            nome: "Atacadão",
            host: 'https://www.atacadao.com.br',
            regionId: 'v2.B8DCB8B9A6E97811ED86748D0F84492B', // ou será obtido dinamicamente
            scList: [1, 2, 3],
            sellers: SELLERS_ATACADAO,
            useSimulationFallback: true
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

        // Obter regionId dinâmico para lojas que não têm fixo
        for (const cfg of configs) {
            if (!cfg.regionId) {
                const region = await obterRegionId(cfg.host, CEP_PADRAO);
                if (region) cfg.regionId = region;
            }
        }

        const monitorados = await dicionarioCol.find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();
        if (monitorados.length === 0) {
            context.res = { status: 200, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        for (const prod of monitorados) {
            const promessasBusca = configs.map(async (lojaConfig) => {
                try {
                    const ultimoPrecoWeb = await obterUltimoPrecoValido(db, prod.nome_comum, lojaConfig.nome);
                    const precoReferencia = prod.preco_alvo || ultimoPrecoWeb;
                    const temAlvo = precoReferencia !== Infinity;

                    // Usa a função unificada de busca
                    const resultado = await buscarProduto(lojaConfig, prod.ean, prod.nome_comum, null);

                    if (resultado) {
                        return {
                            produto: prod.nome_comum,
                            loja: lojaConfig.nome,
                            origem: resultado.nomeLojaOrigem || lojaConfig.nome,
                            link: resultado.link,
                            status: "ENCONTRADO",
                            preco: resultado.preco,
                            precoReferencia,
                            ultimoPrecoWeb,
                            temAlvo
                        };
                    } else {
                        return {
                            produto: prod.nome_comum,
                            loja: lojaConfig.nome,
                            origem: "N/A",
                            status: "NÃO ENCONTRADO",
                            preco: 0
                        };
                    }
                } catch (err) {
                    return {
                        produto: prod.nome_comum,
                        loja: lojaConfig.nome,
                        origem: "ERRO",
                        status: "ERRO DE CONEXÃO",
                        preco: 0
                    };
                }
            });

            const resultadosDoProduto = await Promise.all(promessasBusca);

            for (const res of resultadosDoProduto) {
                relatorio.push({
                    produto: res.produto,
                    loja: res.loja,
                    origem: res.origem,
                    status: res.status,
                    ...(res.preco > 0 && { preco: res.preco, referencia_usada: res.precoReferencia })
                });

                if (res.status === "ENCONTRADO" && res.preco > 0) {
                    if (res.temAlvo && res.preco < res.precoReferencia) {
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
                                preco_historico: res.precoReferencia,
                                preco_atual: res.preco,
                                link_compra: res.link,
                                data_alerta: new Date(),
                                status_notificacao: "pendente"
                            });
                        }
                    }

                    if (res.preco !== res.ultimoPrecoWeb) {
                        await db.collection('historico_precos_web').insertOne({
                            nome: res.produto,
                            ean: prod.ean,
                            loja: res.loja,
                            origem: res.origem,
                            preco: res.preco,
                            data_verificacao: new Date()
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
        context.res = {
            status: 500,
            body: { erro: "Erro Crítico: " + e.message }
        };
    } finally {
        if (client) await client.close();
    }
};

// ============================================================================
// FUNÇÃO AUXILIAR: OBTER ÚLTIMO PREÇO
// ============================================================================
async function obterUltimoPrecoValido(db, nomeProduto, nomeLoja) {
    const ultimo = await db.collection('historico_precos_web')
        .find({ nome: nomeProduto, loja: nomeLoja, preco: { $gt: 0 } })
        .sort({ data_verificacao: -1 })
        .limit(1)
        .toArray();
    return ultimo.length > 0 ? ultimo[0].preco : Infinity;
}