const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// CONFIGURAÇÕES
// ============================================================================
const CEP_PADRAO = process.env.CEP_PADRAO || '06093085';
const TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const CONCURRENT_LIMIT = 5;

// Cookies fixos para o Sam's Club (capturados manualmente)
const COOKIES_SAMS_FIXO = {
    'vtex-search-anonymous': '17e194a2458a485b84ca44d0c9f34b72',
    'checkout.vtex.com': '__ofid=1131ced6adfa4728aa698f1685490545',
    '_snrs_puuid': '0dca3641-507f-409d-b339-1500f0834558',
    '_snrs_uuid': '0c13903f-00b3-491d-81f5-04f53d89b439',
    '__privaci_cookie_consent_uuid': 'bd1e27aa-aa54-4e71-8532-8499e1076057:23',
    '__privaci_cookie_consent_generated': 'bd1e27aa-aa54-4e71-8532-8499e1076057:23',
    'vtex_binding_address': 'samsclub.myvtex.com/',
    '__privaci_cookie_consents': '{"consents":{"85":1,"86":1,"87":1,"88":1,"131":1},"location":"SP#BR","lang":"en","gpcInBrowserOnConsent":false,"gpcStatusInPortalOnConsent":false,"status":"record-consent-success","implicit_consent":false}',
    '__privaci_latest_published_version': '24',
    'CheckoutOrderFormOwnership': '',
    '_snrs_p': 'host:www.samsclub.com.br&permUuid:0dca3641-507f-409d-b339-1500f0834558&uuid:0c13903f-00b3-491d-81f5-04f53d89b439&identityHash:&user_hash:&init:1775384116&last:1779235855.16&current:1779236549&uniqueVisits:3&allVisits:12&globalControlGroup:false',
    'session-id': '105f1b66-c078-4531-a67b-c74d080d241c',
    'vtex-search-session': '0fb2c924560b4fe589356d000b9e88f7',
    'dtCookiejt4qmidn': 'v_4_srv_4_sn_5AC89F6F0EECF62EE2EFAF294B12789B_perc_100000_ol_0_mul_1_app-3A70b4154198f819b8_1_rcs-3Acss_0',
    '__utmzz': 'utmcsr=direct|utmcmd=direct|utmccn=not set',
    '__utmzzses': '1',
    'cf_clearance': 'jtPWHGHIQHDDgWMCtserM_JEKDCdjwxf6XJgLT_9Pj8-1784388081-1.2.1.1-7TRMOcVpzqqqRa03_u8xjgxt0Dz7SUDWCEj4Wbs1w940LNGDvKNXdknANVrP8li5fuBhP6bO_wbIz_VBE8V5vb_HqG1JqMScDnn90IwU0ikr0SGEA4p_TLow9SP8KJoFDeiZLxoIEUBmkNx8kMn8bU2A88BstTGtMXrIe47Ypc0P0DAotshtriPj0zrADDkBYkZbw5GXZaCcBC6eZE8w_rHnLjF7R_W7k2ZUU17VpSx1kWXGamiMCsrZfSTYmdiWUUtf2tAodexjZxh5pMzndSxhHcw9djmmHJqBrGAT_GMBwpxUuxAfeZK.1P97Yi6uaTkpCPlAhikCvvpVk8LFZQ',
    '__cf_bm': '5WK7KKMD2RhTCcbTqeEb7wS3WP1zwDrENW6VotkpQds-1784388081.6242666-1.0.1.1-l.uJl8N0dig_WJxjkVxtQA_89a29SujwV9JzqwXAqBI8bYpZUPk0SOBoznclVRWMMSY1OenEHQWpVaqjvEvZyGknXk1GPXGJcUSKwKWfl8shTSXMbQdj7rUbCdzcWzLC',
    '_ga': 'GA1.1.800491781.1784388082',
    '_gcl_au': '1.1.48152534.1784388081.-.-.1784388081.912638720.1784388082.1784388082',
    'region-id': 'IlUxY2pjMkZ0YzJOc2RXSTJNRFU0TzNOaGJYTmpiSFZpTmpVME5nPT0i',
    'cep': 'IjA2MDkzLTA4NSI%3D',
    'cep_carrefour_ja': '06093-085',
    'cep-address': 'IlNhbSdzIENsdWIgT3Nhc2NvIg%3D%3D',
    'dtm_token_sc': 'AQAGbbqWnyLOlwEexR7rAQBFCwABAQCedN0pKQEBAJ503Skp',
    '_orderform_id_sams': '__ofid%3D1131ced6adfa4728aa698f1685490545',
    '_ga_W2X18P93XW': 'GS2.1.s1784388082$o1$g1$t1784388840$j10$l0$h1533723721',
    '_ga_0H0C0GG1XW': 'GS2.1.s1784388083$o1$g1$t1784388840$j10$l0$h1413406445'
};

// ============================================================================
// 1. FUNÇÃO: REQUISIÇÃO COM RETRY, TIMEOUT E COOKIES (genérico)
// ============================================================================
function buscarDadosComRetry(url, tentativa = 1, cookies = {}) {
    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const cookieString = Object.entries(cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');

        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Cookie': cookieString
            },
            timeout: TIMEOUT_MS
        };

        const req = https.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let novaUrl = res.headers.location;
                if (novaUrl.startsWith('/')) novaUrl = `https://${urlObj.hostname}${novaUrl}`;
                return resolve(buscarDadosComRetry(novaUrl, tentativa, cookies));
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
                console.warn(`Timeout na tentativa ${tentativa}, tentando novamente...`);
                setTimeout(() => resolve(buscarDadosComRetry(url, tentativa + 1, cookies)), 1000 * tentativa);
            } else resolve(null);
        });

        req.on('error', (err) => {
            if (tentativa < MAX_RETRIES) {
                console.warn(`Erro na tentativa ${tentativa}: ${err.message}, tentando novamente...`);
                setTimeout(() => resolve(buscarDadosComRetry(url, tentativa + 1, cookies)), 1000 * tentativa);
            } else resolve(null);
        });

        req.end();
    });
}

// ============================================================================
// 2. FUNÇÃO: SIMULAÇÃO DE CARRINHO
// ============================================================================
async function simularCarrinho(host, regionId, sku, sellerId, sc = 1, cookies = {}) {
    const url = `${host}/api/checkout/pub/orderForms/simulation?sc=${sc}`;
    const payload = {
        items: [{ id: sku, quantity: 1, seller: sellerId }],
        regionId: regionId || '',
        country: 'BRA'
    };

    const cookieString = Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');

    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json',
                'Cookie': cookieString
            },
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
// 3. FUNÇÃO: EXTRAIR INFORMAÇÕES DOS DADOS
// ============================================================================
function extrairInfoProduto(data) {
    if (!data || data.length === 0) return null;
    const item = data[0];
    if (!item.items || item.items.length === 0) return null;
    const variant = item.items[0];
    return {
        sku: variant.itemId,
        linkText: item.linkText,
        link: item.link || `https://${item.linkText}/p`,
        name: item.productName
    };
}

function extrairPrecoDireto(data) {
    if (!data || data.length === 0) return null;
    for (const item of data) {
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
// 4. FUNÇÃO: OBTER REGIONID (com fallback para fixo)
// ============================================================================
async function obterRegionIdPorLoja(cfg, cep, cookies = {}) {
    if (cfg.regionIdFixo) {
        return cfg.regionIdFixo;
    }
    try {
        const url = `${cfg.host}/api/checkout/pub/regions?country=BRA&postalCode=${cep}`;
        const data = await buscarDadosComRetry(url, 1, cookies);
        if (data && data.length > 0) {
            const region = data.find(r => r.id && r.id.startsWith('v2.'));
            return region ? region.id : data[0].id;
        }
    } catch (e) {
        console.warn(`Falha ao obter regionId para ${cfg.nome}:`, e.message);
    }
    return null;
}

// ============================================================================
// 5. BUSCA DE PRODUTO PARA UMA LOJA
// ============================================================================
async function buscarProdutoNaLoja(host, regionId, sc, ean, produtoNome, sellersList, cookies = {}) {
    // Busca por EAN
    let url = `${host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}&sc=${sc}`;
    if (regionId) url += `&regionId=${regionId}`;
    url += `&_=${Date.now()}`;

    let dados = await buscarDadosComRetry(url, 1, cookies);
    let sku = null, linkText = null, link = null;

    if (dados && dados.length > 0) {
        const info = extrairInfoProduto(dados);
        if (info) {
            sku = info.sku;
            linkText = info.linkText;
            link = info.link;
        }
        const precoDireto = extrairPrecoDireto(dados);
        if (precoDireto) {
            return { ...precoDireto, link };
        }
    }

    // Fallback por nome
    if (!sku) {
        const urlNome = `${host}/api/catalog_system/pub/products/search?fq=productName:${encodeURIComponent(produtoNome)}&sc=${sc}`;
        const urlCompleta = regionId ? `${urlNome}&regionId=${regionId}&_=${Date.now()}` : `${urlNome}&_=${Date.now()}`;
        dados = await buscarDadosComRetry(urlCompleta, 1, cookies);
        if (dados && dados.length > 0) {
            const info = extrairInfoProduto(dados);
            if (info) {
                sku = info.sku;
                linkText = info.linkText;
                link = info.link;
            }
        }
    }

    if (!sku) {
        return null;
    }

    // Simulação com sellers fornecidos
    if (sellersList && sellersList.length > 0) {
        for (const seller of sellersList) {
            const sim = await simularCarrinho(host, regionId, sku, seller, sc, cookies);
            if (sim && sim.preco > 0) {
                return {
                    preco: sim.preco,
                    nomeLojaOrigem: `Loja (${seller})`,
                    sku: sku,
                    link: link || `https://${host}/${linkText}/p`,
                    seller: seller
                };
            }
        }
    }

    // Fallback com seller '1'
    const simDefault = await simularCarrinho(host, regionId, sku, '1', sc, cookies);
    if (simDefault && simDefault.preco > 0) {
        return {
            preco: simDefault.preco,
            nomeLojaOrigem: 'Loja (padrão)',
            sku: sku,
            link: link || `https://${host}/${linkText}/p`,
            seller: '1'
        };
    }

    return null;
}

// ============================================================================
// 6. FUNÇÃO PRINCIPAL – AZURE FUNCTION
// ============================================================================
module.exports = async function (context, req) {
    const configs = [
        {
            id: 'SAMS',
            nome: "Sam's Club",
            host: 'https://www.samsclub.com.br',
            scList: [1, 2, 3],
            sellers: ['1', '2', '3', '4', '5'],
            regionIdFixo: 'IlUxY2pjMkZ0YzJOc2RXSTJNRFU0TzNOaGJYTmpiSFZpTmpVME5nPT0i',
            cookies: COOKIES_SAMS_FIXO
        },
        {
            id: 'ATACADAO',
            nome: "Atacadão",
            host: 'https://www.atacadao.com.br',
            scList: [1, 2, 3],
            sellers: [
                'atacadaobr637',
                'atacadaobr634',
                'atacadaobr649',
                'atacadaobr680',
                'atacadaobr697',
                'atacadaobr698',
                'atacadaobr938',
                'atacadaobr939'
            ],
            regionIdFixo: null,
            cookies: {}
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

        // Obter regionId para cada loja
        const regionIds = {};
        for (const cfg of configs) {
            regionIds[cfg.id] = await obterRegionIdPorLoja(cfg, CEP_PADRAO, cfg.cookies);
            context.log(`${cfg.nome} regionId: ${regionIds[cfg.id] || 'N/A'}`);
        }

        const monitorados = await dicionarioCol.find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();
        if (monitorados.length === 0) {
            context.res = { status: 200, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        const total = monitorados.length;
        for (let i = 0; i < total; i += CONCURRENT_LIMIT) {
            const batch = monitorados.slice(i, i + CONCURRENT_LIMIT);
            const batchPromises = batch.map(async (prod) => {
                const resultadosProduto = [];

                for (const cfg of configs) {
                    let encontrado = false;
                    const cookies = cfg.cookies || {};
                    for (const sc of cfg.scList) {
                        const regionId = regionIds[cfg.id];
                        const resultado = await buscarProdutoNaLoja(
                            cfg.host,
                            regionId,
                            sc,
                            prod.ean,
                            prod.nome_comum,
                            cfg.sellers,
                            cookies
                        );
                        if (resultado) {
                            const ultimoPrecoWeb = await obterUltimoPrecoValido(db, prod.nome_comum, cfg.nome);
                            const precoReferencia = prod.preco_alvo || ultimoPrecoWeb || Infinity;
                            const temAlvo = precoReferencia !== Infinity;

                            const entry = {
                                produto: prod.nome_comum,
                                loja: cfg.nome,
                                origem: resultado.nomeLojaOrigem || 'N/A',
                                status: resultado.preco > 0 ? 'ENCONTRADO' : 'SEM ESTOQUE (Preço 0,00)',
                                preco: resultado.preco,
                                referencia_usada: temAlvo ? precoReferencia : null,
                                ultimoPrecoWeb: ultimoPrecoWeb,
                                link: resultado.link || ''
                            };
                            resultadosProduto.push(entry);

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
                                    origem: resultado.nomeLojaOrigem || 'N/A',
                                    preco: resultado.preco,
                                    data_verificacao: new Date()
                                });
                            }

                            encontrado = true;
                            break;
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
            for (const res of batchResults) {
                relatorio.push(...res);
            }
        }

        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: relatorio
        };

    } catch (e) {
        context.log.error('Erro crítico:', e);
        context.res = {
            status: 500,
            body: { erro: "Erro Crítico: " + e.message }
        };
    } finally {
        if (client) await client.close();
    }
};

// ============================================================================
// 7. FUNÇÃO AUXILIAR: OBTER ÚLTIMO PREÇO VÁLIDO
// ============================================================================
async function obterUltimoPrecoValido(db, nomeProduto, nomeLoja) {
    const ultimo = await db.collection('historico_precos_web')
        .find({ nome: nomeProduto, loja: nomeLoja, preco: { $gt: 0 } })
        .sort({ data_verificacao: -1 })
        .limit(1)
        .toArray();
    return ultimo.length > 0 ? ultimo[0].preco : Infinity;
}