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
// FUNÇÕES DE REDE (Helper com Retry)
// ============================================================================
function fazerRequisicao(options, payload = null, tentativa = 1) {
    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(fazerRequisicao({ ...options, path: res.headers.location }, payload, tentativa));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { resolve(null); }
            });
        });

        req.on('error', () => tentativa < MAX_RETRIES ? setTimeout(() => resolve(fazerRequisicao(options, payload, tentativa + 1)), 1000) : resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        
        if (payload) req.write(JSON.stringify(payload));
        req.end();
    });
}

// ============================================================================
// LÓGICA DE NEGÓCIO
// ============================================================================
async function simularCarrinho(host, regionId, sku, sellerId, sc, cookies, binding) {
    const urlObj = new URL(`${host}/api/checkout/pub/orderForms/simulation?sc=${sc}`);
    const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
            'x-vtex-binding': binding || ''
        },
        timeout: TIMEOUT_MS
    };

    const data = await fazerRequisicao(options, {
        items: [{ id: sku, quantity: 1, seller: sellerId }],
        regionId: regionId || '',
        country: 'BRA'
    });

    if (data?.items?.[0]?.price > 0 && data.items[0].availability === 'available') {
        return { preco: data.items[0].price / 100, seller: sellerId, available: true };
    }
    return null;
}

async function buscarProdutoSams(cfg, regionId, ean, produtoNome, cookies) {
    // 1. Busca por EAN (ou Nome se EAN falhar)
    const url = `${cfg.host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}&sc=${cfg.scList[0]}&regionId=${regionId || ''}`;
    const produtos = await fazerRequisicao({ hostname: new URL(cfg.host).hostname, path: url.replace(cfg.host, ''), headers: { 'Accept': 'application/json' } });
    
    if (!produtos || produtos.length === 0) return null;

    const sku = produtos[0].items[0].itemId;
    const link = produtos[0].link;

    // 2. Tenta encontrar preço iterando SCs e Sellers (O PULO DO GATO)
    for (const sc of cfg.scList) {
        for (const seller of cfg.sellers) {
            const sim = await simularCarrinho(cfg.host, regionId, sku, seller, sc, cookies, cfg.binding);
            if (sim) {
                return { preco: sim.preco, nomeLojaOrigem: `Sam's Club (S:${seller}/SC:${sc})`, sku, link };
            }
        }
    }
    return null;
}

// ============================================================================
// MAIN AZURE FUNCTION
// ============================================================================
module.exports = async function (context, req) {
    const configs = [{
        id: 'SAMS',
        nome: "Sam's Club",
        host: 'https://www.samsclub.com.br',
        scList: [1, 2, 3],
        sellers: ['1', 'samsclub', 'samsclubbr'],
        binding: 'samsclub.myvtex.com/'
    }];

    let client = null;
    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        const monitorados = await db.collection('dicionario_produtos').find({ monitorar: true }).toArray();

        let relatorio = [];
        for (const prod of monitorados) {
            for (const cfg of configs) {
                // Tenta buscar (regionId dinâmico se necessário)
                const res = await buscarProdutoSams(cfg, '', prod.ean, prod.nome_comum, {});
                
                if (res) {
                    relatorio.push({ ...res, produto: prod.nome_comum, status: 'ENCONTRADO' });
                } else {
                    relatorio.push({ produto: prod.nome_comum, status: 'NÃO ENCONTRADO', preco: 0 });
                }
            }
        }

        context.res = { body: relatorio };
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};