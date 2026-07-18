const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// CONFIGURAÇÕES GLOBAIS
// ============================================================================
const CEP_PADRAO = process.env.CEP_PADRAO || '06093085';
const TIMEOUT_MS = 8000;           // 8 segundos é o ideal. Se a VTEX não responder, cortamos.
const MAX_RETRIES = 2;             // Reduzido para não agarrar em requisições mortas
const CONCURRENT_LIMIT = 10;       // Agora aguenta 10 produtos simultâneos
const DELAY_BETWEEN_BATCHES = 300; // Apenas 300ms de respiro entre lotes

// ============================================================================
// 1. AGENTE KEEP-ALIVE (Alta performance)
// ============================================================================
const agent = new https.Agent({ 
    keepAlive: true, 
    maxSockets: 100, // Ampla capacidade para não enfileirar no Node
    keepAliveMsecs: 3000
});

// ============================================================================
// 2. FUNÇÕES DE REDE E REQUISIÇÃO
// ============================================================================

async function obterCookiesSams(host) {
    return new Promise((resolve) => {
        const url = new URL(host);
        const options = {
            hostname: url.hostname, path: '/', method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)', 'Accept': 'text/html', 'Connection': 'keep-alive' },
            timeout: TIMEOUT_MS, agent: agent
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
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)', 'Accept': 'application/json',
            'Cookie': Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
            'Connection': 'keep-alive'
        };
        if (binding) headers['x-vtex-binding'] = binding;

        const options = {
            hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'GET',
            headers: headers, timeout: TIMEOUT_MS, agent: agent
        };

        const req = https.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let novaUrl = res.headers.location.startsWith('/') ? `https://${urlObj.hostname}${res.headers.location}` : res.headers.location;
                return resolve(buscarDadosComRetry(novaUrl, tentativa, cookies, binding));
            }
            if (res.statusCode !== 200) return resolve(null);
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        
        req.on('timeout', () => {
            req.destroy();
            tentativa < MAX_RETRIES ? resolve(buscarDadosComRetry(url, tentativa + 1, cookies, binding)) : resolve(null);
        });
        req.on('error', () => tentativa < MAX_RETRIES ? resolve(buscarDadosComRetry(url, tentativa + 1, cookies, binding)) : resolve(null));
        req.end();
    });
}

async function simularCarrinhoLote(host, regionId, sku, sellersList, sc = 1, cookies = {}, binding = null) {
    const url = `${host}/api/checkout/pub/orderForms/simulation?sc=${sc}`;
    const sellers = Array.isArray(sellersList) ? sellersList : [sellersList];
    const payload = { items: sellers.map(s => ({ id: sku, quantity: 1, seller: s })), regionId: regionId || '', country: 'BRA' };
    
    const headers = {
        'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json',
        'Cookie': Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'Connection': 'keep-alive'
    };
    if (binding) headers['x-vtex-binding'] = binding;

    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'POST', headers: headers, timeout: TIMEOUT_MS, agent: agent };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.items && json.items.length > 0) {
                        for (const targetSeller of sellers) {
                            const item = json.items.find(i => i.seller === targetSeller);
                            if (item && item.price > 0 && item.availability === 'available') {
                                resolve({ preco: item.price / 100, seller: item.seller, available: true }); return;
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
// 3. LÓGICA DE NEGÓCIO OTIMIZADA
// ============================================================================

async function obterRegionIdPorLoja(cfg, cep, cookies = {}) {
    if (cfg.regionIdFixo) return cfg.regionIdFixo;
    const url = `${cfg.host}/api/checkout/pub/regions?country=BRA&postalCode=${cep}`;
    const data = await buscarDadosComRetry(url, 1, cookies, cfg.binding || null);
    return (data && data.length > 0) ? (data.find(r => r.id && r.id.startsWith('v2.'))?.id || data[0].id) : null;
}

// NOVO: Busca apenas o SKU para economizar rede. Não perde tempo com SCs vazios.
async function obterSkuNaLoja(host, ean, produtoNome, cookies, binding) {
    let url = `${host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}&sc=1&_=${Date.now()}`;
    let dados = await buscarDadosComRetry(url, 1, cookies, binding);
    
    if (dados && dados.length > 0 && dados[0].items && dados[0].items.length > 0) {
        return { sku: dados[0].items[0].itemId, link: dados[0].link || `https://${host}/${dados[0].linkText}/p` };
    }
    
    const nomeExato = encodeURIComponent(produtoNome);
    let urlNome = `${host}/api/catalog_system/pub/products/search?fq=productName:${nomeExato}&sc=1&_=${Date.now()}`;
    dados = await buscarDadosComRetry(urlNome, 1, cookies, binding);
    
    if (dados && dados.length > 0) {
        const candidato = dados.find(p => p.productName && p.productName.toLowerCase().includes(produtoNome.toLowerCase()));
        if (candidato && candidato.items && candidato.items.length > 0) {
            return { sku: candidato.items[0].itemId, link: candidato.link || `https://${host}/${candidato.linkText}/p` };
        }
    }
    return null;
}

async function obterUltimoPrecoValido(db, nomeProduto, nomeLoja) {
    const ultimo = await db.collection('historico_precos_web')
        .find({ nome: nomeProduto, loja: nomeLoja, preco: { $gt: 0 } }).sort({ _id: -1 }).limit(1).toArray();
    return ultimo.length > 0 ? ultimo[0].preco : Infinity;
}

// ============================================================================
// 4. MAIN AZURE FUNCTION
// ============================================================================

module.exports = async function (context, req) {
    const configs = [
        {
            id: 'ATACADAO', nome: "Atacadão", host: 'https://www.atacadao.com.br', scList: [1, 2, 3],
            sellers: ['atacadaobr637', 'atacadaobr634', 'atacadaobr649', 'atacadaobr680', 'atacadaobr697', 'atacadaobr698', 'atacadaobr938', 'atacadaobr939'],
            regionIdFixo: null, binding: null, usarCookies: false
        },
        {
            id: 'SAMS', nome: "Sam's Club", host: 'https://www.samsclub.com.br', scList: [1, 2, 3],
            sellers: ['samsclub6058', 'samsclub6546', '1','2','3','4','5','6','7','8','9','10', 'samsclub', 'samsclubbr'],
            regionIdFixo: 'IlUxY2pjMkZ0YzJOc2RXSTJNRFU0TzNOaGJYTmpiSFZpTmpVME5nPT0i', binding: 'samsclub.myvtex.com/', usarCookies: true
        }
    ];

    let client = null;
    let relatorio = [];

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        
        const cookiesMap = {};
        for (const cfg of configs) cookiesMap[cfg.id] = cfg.usarCookies ? await obterCookiesSams(cfg.host) : {};
        
        const regionIds = {};
        for (const cfg of configs) regionIds[cfg.id] = await obterRegionIdPorLoja(cfg, CEP_PADRAO, cookiesMap[cfg.id]);

        const monitorados = await db.collection('dicionario_produtos').find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();
        if (monitorados.length === 0) {
            context.res = { status: 200, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        // Processamento em Lotes Otimizado
        for (let i = 0; i < monitorados.length; i += CONCURRENT_LIMIT) {
            const batch = monitorados.slice(i, i + CONCURRENT_LIMIT);
            const batchDbOps = []; // Enfileira operações do DB

            const batchPromises = batch.map(async (prod) => {
                const promessasLojas = configs.map(async (cfg) => {
                    const cookies = cookiesMap[cfg.id];
                    const regionId = regionIds[cfg.id];
                    
                    // PASSO MÁGICO 1: Acha o SKU apenas 1x (salva muitas requisições HTTP)
                    const infoProd = await obterSkuNaLoja(cfg.host, prod.ean, prod.nome_comum, cookies, cfg.binding);
                    
                    if (infoProd) {
                        const sellerPreferido = prod.seller_preferido || null;
                        let sellersToTry = cfg.sellers;
                        if (sellerPreferido && cfg.sellers.includes(sellerPreferido)) {
                            sellersToTry = [sellerPreferido, ...cfg.sellers.filter(s => s !== sellerPreferido)];
                        }

                        // PASSO MÁGICO 2: Testa estoque apenas se o SKU existia
                        for (const sc of cfg.scList) {
                            const sim = await simularCarrinhoLote(cfg.host, regionId, infoProd.sku, sellersToTry, sc, cookies, cfg.binding);
                            
                            if (sim && sim.preco > 0) {
                                // Escritas não bloqueiam o fluxo. São enviadas pro batchDbOps
                                if (sim.seller && sim.seller !== sellerPreferido) {
                                    batchDbOps.push(db.collection('dicionario_produtos').updateOne({ _id: prod._id }, { $set: { seller_preferido: sim.seller } }));
                                }

                                const ultimoPrecoWeb = await obterUltimoPrecoValido(db, prod.nome_comum, cfg.nome);
                                const precoReferencia = prod.preco_alvo || ultimoPrecoWeb || Infinity;

                                if (precoReferencia !== Infinity && sim.preco < precoReferencia) {
                                    const jaExiste = await db.collection('alertas_preco').findOne({ produto_nome: prod.nome_comum, loja: cfg.nome, preco_atual: sim.preco, status_notificacao: "pendente" });
                                    if (!jaExiste) {
                                        batchDbOps.push(db.collection('alertas_preco').insertOne({
                                            produto_nome: prod.nome_comum, loja: cfg.nome, preco_historico: precoReferencia, preco_atual: sim.preco,
                                            link_compra: infoProd.link, data_alerta: new Date(), status_notificacao: "pendente"
                                        }));
                                    }
                                }

                                if (ultimoPrecoWeb === Infinity || sim.preco !== ultimoPrecoWeb) {
                                    batchDbOps.push(db.collection('historico_precos_web').insertOne({
                                        nome: prod.nome_comum, ean: prod.ean, loja: cfg.nome, origem: sim.seller, preco: sim.preco, data_verificacao: new Date()
                                    }));
                                }

                                return {
                                    produto: prod.nome_comum, loja: cfg.nome, origem: sim.seller, status: 'ENCONTRADO',
                                    preco: sim.preco, referencia_usada: precoReferencia !== Infinity ? precoReferencia : null,
                                    ultimoPrecoWeb: ultimoPrecoWeb !== Infinity ? ultimoPrecoWeb : null, link: infoProd.link
                                };
                            }
                        }
                    }

                    // Se falhou em obter SKU ou simular estoque
                    return {
                        produto: prod.nome_comum, loja: cfg.nome, origem: 'N/A', status: 'NÃO ENCONTRADO', 
                        preco: 0, referencia_usada: null, ultimoPrecoWeb: null, link: ''
                    };
                });

                return await Promise.all(promessasLojas);
            });

            // Aguarda o lote de requisições HTTP finalizar
            const batchResultsMatrix = await Promise.all(batchPromises);
            for (const resArray of batchResultsMatrix) relatorio.push(...resArray);

            // PASSO MÁGICO 3: Descarrega todas as escritas no Mongo de uma vez
            if (batchDbOps.length > 0) await Promise.all(batchDbOps);

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