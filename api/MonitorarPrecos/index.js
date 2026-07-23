const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// CONFIGURAÇÕES GLOBAIS
// ============================================================================
const CEP_PADRAO = process.env.CEP_PADRAO || '06093085';
const TIMEOUT_MS = 10000;          // 10 segundos (reduzido para evitar travamento infinito)
const MAX_RETRIES = 3;             // 3 tentativas
const CONCURRENT_LIMIT = 5;        // Aumentado para 5, já que agora está super rápido
const DELAY_BETWEEN_BATCHES = 500; // Apenas 0.5s de pausa, requisições foram drasticamente reduzidas

// ============================================================================
// 1. AGENTE KEEP-ALIVE (Alta performance)
// ============================================================================
const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 50, // Permite mais conexões simultâneas sem enfileirar
    keepAliveMsecs: 3000
});

// ============================================================================
// 2. FUNÇÕES AUXILIARES DE REQUISIÇÃO
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
                'Connection': 'keep-alive'
            },
            timeout: TIMEOUT_MS,
            agent: agent
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
            } else resolve({});
        });

        req.on('error', () => resolve({}));
        req.on('timeout', () => { req.destroy(); resolve({}); });
        req.end();
    });
}

function buscarDadosComRetry(url, tentativa = 1, cookies = {}, binding = null) {
    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const cookieString = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json',
            'Cookie': cookieString,
            'Connection': 'keep-alive'
        };
        if (binding) headers['x-vtex-binding'] = binding;

        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: headers,
            timeout: TIMEOUT_MS,
            agent: agent
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
            if (tentativa < MAX_RETRIES) {
                setTimeout(() => resolve(buscarDadosComRetry(url, tentativa + 1, cookies, binding)), 500);
            } else resolve(null);
        });

        req.on('error', () => {
            if (tentativa < MAX_RETRIES) {
                setTimeout(() => resolve(buscarDadosComRetry(url, tentativa + 1, cookies, binding)), 500);
            } else resolve(null);
        });

        req.end();
    });
}

// ============================================================================
// SIMULAÇÃO EM LOTE: O SEGREDO DA PERFORMANCE
// Manda TODOS os sellers juntos. VTEX processa todos de uma vez.
// ============================================================================
async function simularCarrinhoLote(host, regionId, sku, sellersList, sc = 1, cookies = {}, binding = null) {
    const url = `${host}/api/checkout/pub/orderForms/simulation?sc=${sc}`;
    const sellers = Array.isArray(sellersList) ? sellersList : [sellersList];

    // Monta um carrinho com 1 item para CADA seller da lista (a VTEX calcula todos de uma vez)
    const payload = {
        items: sellers.map(seller => ({ id: sku, quantity: 1, seller: seller })),
        regionId: regionId || '',
        country: 'BRA'
    };

    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
        'Cookie': Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
        'Connection': 'keep-alive'
    };
    if (binding) headers['x-vtex-binding'] = binding;

    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: headers,
            timeout: TIMEOUT_MS,
            agent: agent
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.items && json.items.length > 0) {
                        // Verifica a resposta priorizando os sellers na ordem que você configurou
                        for (const targetSeller of sellers) {
                            const item = json.items.find(i => i.seller === targetSeller);
                            if (item && item.price > 0 && item.availability === 'available') {
                                resolve({ preco: item.price / 100, seller: item.seller, available: true });
                                return;
                            }
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
// 3. FUNÇÕES DE EXTRAÇÃO
// ============================================================================

function extrairInfoProduto(data) {
    if (!data || data.length === 0) return null;
    const item = data[0];
    if (!item.items || item.items.length === 0) return null;
    const variant = item.items[0];
    return { sku: variant.itemId, linkText: item.linkText, link: item.link || `https://${item.linkText}/p`, name: item.productName };
}

function extrairPrecoDireto(data) {
    if (!data || data.length === 0) return null;
    for (const item of data) {
        if (!item.items) continue;
        for (const variant of item.items) {
            if (!variant.sellers) continue;
            for (const seller of variant.sellers) {
                const offer = seller.commertialOffer;
                if (offer && offer.Price > 0) return { preco: offer.Price, nomeLojaOrigem: seller.sellerName || 'Loja', sku: variant.itemId, seller: seller.sellerId };
            }
        }
    }
    return null;
}

// ============================================================================
// 4. OBTER REGIONID
// ============================================================================

async function obterRegionIdPorLoja(cfg, cep, cookies = {}) {
    if (cfg.regionIdFixo) return cfg.regionIdFixo;
    try {
        const url = `${cfg.host}/api/checkout/pub/regions?country=BRA&postalCode=${cep}`;
        const data = await buscarDadosComRetry(url, 1, cookies, cfg.binding || null);
        if (data && data.length > 0) {
            const region = data.find(r => r.id && r.id.startsWith('v2.'));
            return region ? region.id : data[0].id;
        }
    } catch (e) { }
    return null;
}

// ============================================================================
// 5. BUSCA DE PRODUTO OTIMIZADA
// ============================================================================

async function buscarProdutoNaLoja(host, regionId, sc, ean, produtoNome, sellersList, cookies = {}, binding = null) {
    let url = `${host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}&sc=${sc}&_=${Date.now()}`;
    if (regionId) url += `&regionId=${regionId}`;

    let dados = await buscarDadosComRetry(url, 1, cookies, binding);
    let sku = null, linkText = null, link = null;

    if (dados && dados.length > 0) {
        const info = extrairInfoProduto(dados);
        if (info) { sku = info.sku; linkText = info.linkText; link = info.link; }

        const precoDireto = extrairPrecoDireto(dados);
        if (precoDireto && precoDireto.preco > 0) return { ...precoDireto, link };
    }

    if (!sku) {
        const nomeExato = encodeURIComponent(produtoNome);
        let urlNome = `${host}/api/catalog_system/pub/products/search?fq=productName:${nomeExato}&sc=${sc}&_=${Date.now()}`;
        if (regionId) urlNome += `&regionId=${regionId}`;
        dados = await buscarDadosComRetry(urlNome, 1, cookies, binding);
        if (dados && dados.length > 0) {
            const candidato = dados.find(p => p.productName && p.productName.toLowerCase().includes(produtoNome.toLowerCase()));
            if (candidato) {
                const info = extrairInfoProduto([candidato]);
                if (info) { sku = info.sku; linkText = info.linkText; link = info.link; }
            }
        }
    }

    if (!sku) return null;

    // SIMULAÇÃO EM LOTE: Troca N requisições por apenas 1 requisição
    if (sellersList && sellersList.length > 0) {
        const sim = await simularCarrinhoLote(host, regionId, sku, sellersList, sc, cookies, binding);
        if (sim && sim.preco > 0) {
            return {
                preco: sim.preco,
                nomeLojaOrigem: `${sim.seller}`,
                sku: sku,
                link: link || `https://${host}/${linkText}/p`,
                seller: sim.seller
            };
        }
    } else {
        const simDefault = await simularCarrinhoLote(host, regionId, sku, ['1'], sc, cookies, binding);
        if (simDefault && simDefault.preco > 0) return { preco: simDefault.preco, nomeLojaOrigem: 'padrão', sku, link: link || `https://${host}/${linkText}/p`, seller: '1' };
    }

    return null;
}

// ============================================================================
// 6. HISTÓRICO
// ============================================================================
async function obterUltimoPrecoValido(db, nomeProduto, nomeLoja) {
    const ultimo = await db.collection('historico_precos_web')
        .find({ nome: nomeProduto, loja: nomeLoja, preco: { $gt: 0 } })
        .sort({ _id: -1 }) // Mais leve para o MongoDB do que data_verificacao
        .limit(1)
        .toArray();
    return ultimo.length > 0 ? ultimo[0].preco : Infinity;
}

// ============================================================================
// 7. FUNÇÃO PRINCIPAL OTIMIZADA
// ============================================================================

module.exports = async function (context, req) {
    const configs = [
        {
            id: 'ATACADAO',
            nome: "Atacadão",
            host: 'https://www.atacadao.com.br',
            scList: [1, 2, 3],
            sellers: ['atacadaobr637', 'atacadaobr634', 'atacadaobr649', 'atacadaobr680', 'atacadaobr697', 'atacadaobr698', 'atacadaobr938', 'atacadaobr939'],
            regionIdFixo: null,
            binding: null,
            usarCookies: false
        },
        {
            id: 'SAMS',
            nome: "Sam's Club",
            host: 'https://www.samsclub.com.br',
            scList: [1, 2, 3],
            sellers: ['samsclub6058', 'samsclub6546', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'samsclub', 'samsclubbr'],
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

        const cookiesMap = {};
        for (const cfg of configs) {
            cookiesMap[cfg.id] = cfg.usarCookies ? await obterCookiesSams(cfg.host) : {};
        }

        const regionIds = {};
        for (const cfg of configs) {
            regionIds[cfg.id] = await obterRegionIdPorLoja(cfg, CEP_PADRAO, cookiesMap[cfg.id]);
        }

        const monitorados = await db.collection('dicionario_produtos').find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();
        if (monitorados.length === 0) {
            context.res = { status: 200, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        for (let i = 0; i < monitorados.length; i += CONCURRENT_LIMIT) {
            const batch = monitorados.slice(i, i + CONCURRENT_LIMIT);

            const batchPromises = batch.map(async (prod) => {
                // PARALELISMO DAS LOJAS: Pesquisa no Atacadão e no Sam's Club EXATAMENTE ao mesmo tempo
                const promessasLojas = configs.map(async (cfg) => {
                    let encontrado = false;
                    const cookies = cookiesMap[cfg.id];
                    const regionId = regionIds[cfg.id];

                    const sellerPreferido = prod.seller_preferido || null;
                    let sellersToTry = cfg.sellers;
                    if (sellerPreferido && cfg.sellers.includes(sellerPreferido)) {
                        sellersToTry = [sellerPreferido, ...cfg.sellers.filter(s => s !== sellerPreferido)];
                    }

                    for (const sc of cfg.scList) {
                        const resultado = await buscarProdutoNaLoja(cfg.host, regionId, sc, prod.ean, prod.nome_comum, sellersToTry, cookies, cfg.binding);

                        if (resultado) {
                            if (resultado.seller && resultado.seller !== sellerPreferido) {
                                await db.collection('dicionario_produtos').updateOne({ _id: prod._id }, { $set: { seller_preferido: resultado.seller } });
                            }

                            const ultimoPrecoWeb = await obterUltimoPrecoValido(db, prod.nome_comum, cfg.nome);
                            const precoReferencia = prod.preco_alvo || ultimoPrecoWeb || Infinity;

                            const entry = {
                                produto: prod.nome_comum, loja: cfg.nome, origem: resultado.nomeLojaOrigem || 'N/A', status: 'ENCONTRADO',
                                preco: resultado.preco, referencia_usada: precoReferencia !== Infinity ? precoReferencia : null,
                                ultimoPrecoWeb: ultimoPrecoWeb !== Infinity ? ultimoPrecoWeb : null, link: resultado.link || ''
                            };

                            if (resultado.preco > 0 && precoReferencia !== Infinity && resultado.preco < precoReferencia) {
                                const jaExiste = await db.collection('alertas_preco').findOne({ produto_nome: prod.nome_comum, loja: cfg.nome, preco_atual: resultado.preco, status_notificacao: "pendente" });
                                if (!jaExiste) {
                                    await db.collection('alertas_preco').insertOne({
                                        produto_nome: prod.nome_comum, loja: cfg.nome, preco_historico: precoReferencia, preco_atual: resultado.preco,
                                        link_compra: resultado.link, data_alerta: new Date(), status_notificacao: "pendente"
                                    });
                                }
                            }

                            // Bloco temporariamente comentado para não disparar alertas por enquanto.
                            // Descomente esta seção quando quiser reativar a regra de alerta por queda em relação ao último preço registrado.
                            // if (resultado.preco > 0 && ultimoPrecoWeb !== Infinity && resultado.preco < ultimoPrecoWeb) {
                            //     const jaExiste = await db.collection('alertas_preco').findOne({
                            //         produto_nome: prod.nome_comum,
                            //         loja: cfg.nome,
                            //         preco_atual: resultado.preco,
                            //         status_notificacao: "pendente"
                            //     });
                            //
                            //     if (!jaExiste) {
                            //         await db.collection('alertas_preco').insertOne({
                            //             produto_nome: prod.nome_comum,
                            //             loja: cfg.nome,
                            //             preco_historico: ultimoPrecoWeb, // Registra o preço do qual ele caiu
                            //             preco_atual: resultado.preco,
                            //             link_compra: resultado.link,
                            //             data_alerta: new Date(),
                            //             status_notificacao: "pendente"
                            //         });
                            //     }
                            // }

                            if (ultimoPrecoWeb === Infinity || resultado.preco !== ultimoPrecoWeb) {
                                await db.collection('historico_precos_web').insertOne({
                                    nome: prod.nome_comum, ean: prod.ean, loja: cfg.nome, origem: resultado.nomeLojaOrigem || 'N/A',
                                    preco: resultado.preco, data_verificacao: new Date()
                                });
                            }
                            encontrado = true;
                            return entry; // Achou neste SC, retorna e encerra a loja
                        }
                    }

                    if (!encontrado) {
                        return {
                            produto: prod.nome_comum, loja: cfg.nome, origem: 'N/A', status: 'NÃO ENCONTRADO', preco: 0,
                            referencia_usada: null, ultimoPrecoWeb: null, link: ''
                        };
                    }
                });

                return await Promise.all(promessasLojas);
            });

            // Aguarda o lote de produtos (onde as lojas já rodaram em paralelo internamente)
            const batchResultsMatrix = await Promise.all(batchPromises);
            for (const resArray of batchResultsMatrix) relatorio.push(...resArray);

            if (i + CONCURRENT_LIMIT < monitorados.length) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
            }
        }

        context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: relatorio };

    } catch (e) {
        context.log.error('Erro crítico:', e);
        context.res = { status: 500, body: { erro: "Erro Crítico: " + e.message } };
    } finally {
        if (client) await client.close();
    }
};