const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// CONFIGURAÇÕES
// ============================================================================
const CEP_PADRAO = process.env.CEP_PADRAO || '06093085';
const TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const CONCURRENT_LIMIT = 5; 

// ============================================================================
// 1. FUNÇÃO: OBTER COOKIES DA PÁGINA INICIAL
// ============================================================================
async function obterCookiesSams(host) {
    return new Promise((resolve) => {
        const url = new URL(host);
        const options = {
            hostname: url.hostname,
            path: '/',
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html',
            },
            timeout: TIMEOUT_MS
        };

        const req = https.request(options, (res) => {
            const cookies = res.headers['set-cookie'];
            if (cookies && cookies.length > 0) {
                const cookieObj = {};
                cookies.forEach(c => {
                    const parts = c.split(';')[0].split('=');
                    if (parts.length === 2) cookieObj[parts[0].trim()] = parts[1].trim();
                });
                cookieObj['cep'] = Buffer.from(CEP_PADRAO).toString('base64');
                resolve(cookieObj);
            } else {
                resolve({});
            }
        });
        req.on('error', () => resolve({}));
        req.on('timeout', () => { req.destroy(); resolve({}); });
        req.end();
    });
}

// ============================================================================
// 2. FUNÇÃO: REQUISIÇÃO COM RETRY
// ============================================================================
function buscarDadosComRetry(url, tentativa = 1, cookies = {}, binding = null) {
    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const cookieString = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Cookie': cookieString
        };
        if (binding) headers['x-vtex-binding'] = binding;

        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: headers,
            timeout: TIMEOUT_MS
        };

        const req = https.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let novaUrl = res.headers.location;
                if (novaUrl.startsWith('/')) novaUrl = `https://${urlObj.hostname}${novaUrl}`;
                return resolve(buscarDadosComRetry(novaUrl, tentativa, cookies, binding));
            }
            if (res.statusCode !== 200) return resolve(null);

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { resolve(null); }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            if (tentativa < MAX_RETRIES) resolve(buscarDadosComRetry(url, tentativa + 1, cookies, binding));
            else resolve(null);
        });

        req.on('error', () => {
            if (tentativa < MAX_RETRIES) resolve(buscarDadosComRetry(url, tentativa + 1, cookies, binding));
            else resolve(null);
        });

        req.end();
    });
}

// ============================================================================
// 3. FUNÇÃO: SIMULAÇÃO DE CARRINHO (AJUSTADA PARA VALIDAR DISPONIBILIDADE)
// ============================================================================
async function simularCarrinho(host, regionId, sku, sellerId, sc, cookies = {}, binding = null) {
    const url = `${host}/api/checkout/pub/orderForms/simulation?sc=${sc}`;
    const payload = {
        items: [{ id: sku, quantity: 1, seller: sellerId }],
        regionId: regionId || '',
        country: 'BRA'
    };

    const cookieString = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Cookie': cookieString
    };
    if (binding) headers['x-vtex-binding'] = binding;

    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: headers,
            timeout: TIMEOUT_MS
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.items && json.items.length > 0) {
                        const item = json.items[0];
                        // VERIFICAÇÃO RÍGIDA: Preço > 0 E availability === 'available'
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
                } catch { resolve(null); }
            });
        });

        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(JSON.stringify(payload));
        req.end();
    });
}

// ============================================================================
// 4. FUNÇÃO: OBTER REGIONID DINÂMICO
// ============================================================================
async function obterRegionIdPorLoja(cfg, cep, cookies = {}) {
    try {
        const url = `${cfg.host}/api/checkout/pub/regions?country=BRA&postalCode=${cep}`;
        const data = await buscarDadosComRetry(url, 1, cookies, cfg.binding || null);
        if (data && data.length > 0) {
            const region = data.find(r => r.id && r.id.startsWith('v2.'));
            return region ? region.id : data[0].id;
        }
    } catch (e) {}
    // Fallback para o fixo caso a API falhe
    return cfg.regionIdFixo || null;
}

// ============================================================================
// 5. FUNÇÃO PRINCIPAL DE BUSCA DO PRODUTO (COMBINADA)
// ============================================================================
async function buscarProdutoSams(host, regionId, sc, ean, produtoNome, sellersList, cookies = {}, binding = null) {
    let url = `${host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}&sc=${sc}`;
    if (regionId) url += `&regionId=${regionId}`;
    
    let dados = await buscarDadosComRetry(url, 1, cookies, binding);
    let sku = null, linkText = null, link = null;

    if (dados && dados.length > 0 && dados[0].items && dados[0].items.length > 0) {
        sku = dados[0].items[0].itemId;
        linkText = dados[0].linkText;
        link = dados[0].link || `https://${host}/${linkText}/p`;
    } else {
        // Fallback por Nome
        const nomeExato = encodeURIComponent(produtoNome);
        let urlNome = `${host}/api/catalog_system/pub/products/search?fq=productName:${nomeExato}&sc=${sc}`;
        if (regionId) urlNome += `&regionId=${regionId}`;
        dados = await buscarDadosComRetry(urlNome, 1, cookies, binding);
        
        if (dados && dados.length > 0) {
            const candidato = dados.find(p => p.productName && p.productName.toLowerCase().includes(produtoNome.toLowerCase()));
            if (candidato && candidato.items && candidato.items.length > 0) {
                sku = candidato.items[0].itemId;
                linkText = candidato.linkText;
                link = candidato.link || `https://${host}/${linkText}/p`;
            }
        }
    }

    if (!sku) return null;

    // SIMULAÇÃO AGRESSIVA COM TODOS OS SELLERS
    for (const seller of sellersList) {
        const sim = await simularCarrinho(host, regionId, sku, seller, sc, cookies, binding);
        if (sim && sim.preco > 0) {
            return {
                preco: sim.preco,
                nomeLojaOrigem: `Sam's Club (S:${seller}/SC:${sc})`,
                sku: sku,
                link: link,
                seller: seller
            };
        }
    }

    return null;
}

async function obterUltimoPrecoValido(db, nomeProduto, nomeLoja) {
    const ultimo = await db.collection('historico_precos_web')
        .find({ nome: nomeProduto, loja: nomeLoja, preco: { $gt: 0 } })
        .sort({ data_verificacao: -1 })
        .limit(1)
        .toArray();
    return ultimo.length > 0 ? ultimo[0].preco : Infinity;
}

// ============================================================================
// 6. MAIN AZURE FUNCTION (ESTRUTURA JSON INTACTA)
// ============================================================================
module.exports = async function (context, req) {
    const configs = [
        {
            id: 'SAMS',
            nome: "Sam's Club",
            host: 'https://www.samsclub.com.br',
            scList: [1, 2, 3], 
            sellers: ['1', 'samsclub', 'samsclubbr', '2', '3'], // Prioridade ajustada
            regionIdFixo: 'IlUxY2pjMkZ0YzJOc2RXSTJNRFU0TzNOaGJYTmpiSFZpTmpVME5nPT0i',
            binding: 'samsclub.myvtex.com/',
            usarCookies: true
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

        const cookiesMap = {};
        const regionIds = {};

        for (const cfg of configs) {
            cookiesMap[cfg.id] = cfg.usarCookies ? await obterCookiesSams(cfg.host) : {};
            // Busca o regionId dinâmico PRIMEIRO. Se falhar, cai pro fixo.
            regionIds[cfg.id] = await obterRegionIdPorLoja(cfg, CEP_PADRAO, cookiesMap[cfg.id]);
        }

        const monitorados = await dicionarioCol.find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();
        if (monitorados.length === 0) {
            context.res = { status: 200, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        for (let i = 0; i < monitorados.length; i += CONCURRENT_LIMIT) {
            const batch = monitorados.slice(i, i + CONCURRENT_LIMIT);
            
            const batchPromises = batch.map(async (prod) => {
                const resultadosProduto = [];

                for (const cfg of configs) {
                    let encontrado = false;
                    const cookies = cookiesMap[cfg.id];
                    const regionId = regionIds[cfg.id];

                    for (const sc of cfg.scList) {
                        const resultado = await buscarProdutoSams(cfg.host, regionId, sc, prod.ean, prod.nome_comum, cfg.sellers, cookies, cfg.binding);
                        
                        if (resultado) {
                            const ultimoPrecoWeb = await obterUltimoPrecoValido(db, prod.nome_comum, cfg.nome);
                            const precoReferencia = prod.preco_alvo || ultimoPrecoWeb || Infinity;
                            const temAlvo = precoReferencia !== Infinity;

                            resultadosProduto.push({
                                produto: prod.nome_comum,
                                loja: cfg.nome,
                                origem: resultado.nomeLojaOrigem,
                                status: 'ENCONTRADO',
                                preco: resultado.preco,
                                referencia_usada: temAlvo ? precoReferencia : null,
                                ultimoPrecoWeb: ultimoPrecoWeb !== Infinity ? ultimoPrecoWeb : null,
                                link: resultado.link
                            });

                            if (resultado.preco > 0 && temAlvo && resultado.preco < precoReferencia) {
                                const jaExiste = await alertasCol.findOne({
                                    produto_nome: prod.nome_comum,
                                    loja: cfg.nome,
                                    preco_atual: resultado.preco,
                                    status_notificacao: "pendente"
                                });
                                if (!jaExiste) {
                                    await alertasCol.insertOne({
                                        produto_nome: prod.nome_comum,
                                        loja: cfg.nome,
                                        preco_historico: precoReferencia,
                                        preco_atual: resultado.preco,
                                        link_compra: resultado.link,
                                        data_alerta: new Date(),
                                        status_notificacao: "pendente"
                                    });
                                }
                            }

                            if (ultimoPrecoWeb === Infinity || resultado.preco !== ultimoPrecoWeb) {
                                await db.collection('historico_precos_web').insertOne({
                                    nome: prod.nome_comum,
                                    ean: prod.ean,
                                    loja: cfg.nome,
                                    origem: resultado.nomeLojaOrigem,
                                    preco: resultado.preco,
                                    data_verificacao: new Date()
                                });
                            }

                            encontrado = true;
                            break; // Se achou neste SC, para de tentar os outros SCs
                        }
                    }

                    if (!encontrado) {
                        resultadosProduto.push({
                            produto: prod.nome_comum,
                            loja: cfg.nome,
                            origem: 'N/A',
                            status: 'NÃO ENCONTRADO',
                            preco: 0,
                            referencia_usada: null,
                            ultimoPrecoWeb: null,
                            link: ''
                        });
                    }
                }
                return resultadosProduto;
            });

            const batchResults = await Promise.all(batchPromises);
            for (const res of batchResults) relatorio.push(...res);
        }

        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: relatorio
        };

    } catch (e) {
        context.log.error('Erro crítico:', e);
        context.res = { status: 500, body: { erro: "Erro Crítico: " + e.message } };
    } finally {
        if (client) await client.close();
    }
};