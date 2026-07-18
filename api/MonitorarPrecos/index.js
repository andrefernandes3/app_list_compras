const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// CONFIGURAÇÕES
// ============================================================================
const CEP_PADRAO = process.env.CEP_PADRAO || '06093085';
const TIMEOUT_MS = 20000; // aumentado para evitar timeout
const MAX_RETRIES = 4;
const CONCURRENT_LIMIT = 3; // reduzido para evitar sobrecarga
const DELAY_BETWEEN_BATCHES = 1500; // 1.5s entre lotes

// ============================================================================
// 1. FUNÇÃO: OBTER COOKIES DA PÁGINA INICIAL (Sam's Club)
// ============================================================================
async function obterCookiesSams(host) {
    return new Promise((resolve) => {
        const url = new URL(host);
        const options = {
            hostname: url.hostname,
            path: '/',
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                'Connection': 'keep-alive'
            },
            timeout: TIMEOUT_MS
        };

        const req = https.request(options, (res) => {
            const cookies = res.headers['set-cookie'];
            if (cookies && cookies.length > 0) {
                const cookieObj = {};
                cookies.forEach(c => {
                    const parts = c.split(';')[0].split('=');
                    if (parts.length === 2) {
                        cookieObj[parts[0].trim()] = parts[1].trim();
                    }
                });
                // Adiciona o CEP manualmente (codificado em base64)
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
// 2. FUNÇÃO: REQUISIÇÃO COM RETRY, TIMEOUT, COOKIES E BINDING (com keep-alive)
// ============================================================================
const agent = new https.Agent({ keepAlive: true, maxSockets: 10 });

function buscarDadosComRetry(url, tentativa = 1, cookies = {}, binding = null) {
    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const cookieString = Object.entries(cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Cookie': cookieString,
            'Connection': 'keep-alive'
        };
        if (binding) {
            headers['x-vtex-binding'] = binding;
        }

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
                const delay = 1000 * Math.pow(2, tentativa - 1);
                console.warn(`Timeout na tentativa ${tentativa}, tentando novamente em ${delay}ms...`);
                setTimeout(() => resolve(buscarDadosComRetry(url, tentativa + 1, cookies, binding)), delay);
            } else resolve(null);
        });

        req.on('error', (err) => {
            if (tentativa < MAX_RETRIES) {
                const delay = 1000 * Math.pow(2, tentativa - 1);
                console.warn(`Erro na tentativa ${tentativa}: ${err.message}, tentando novamente em ${delay}ms...`);
                setTimeout(() => resolve(buscarDadosComRetry(url, tentativa + 1, cookies, binding)), delay);
            } else resolve(null);
        });

        req.end();
    });
}

// ============================================================================
// 3. FUNÇÃO: SIMULAÇÃO DE CARRINHO COM COOKIES E BINDING
// ============================================================================
async function simularCarrinho(host, regionId, sku, sellerId, sc = 1, cookies = {}, binding = null) {
    const url = `${host}/api/checkout/pub/orderForms/simulation?sc=${sc}`;
    const payload = {
        items: [{ id: sku, quantity: 1, seller: sellerId }],
        regionId: regionId || '',
        country: 'BRA'
    };

    const cookieString = Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');

    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Cookie': cookieString,
        'Connection': 'keep-alive'
    };
    if (binding) {
        headers['x-vtex-binding'] = binding;
    }

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
// 4. FUNÇÃO: OBTER REGIONID (com fallback para fixo)
// ============================================================================
async function obterRegionIdPorLoja(cfg, cep, cookies = {}) {
    if (cfg.regionIdFixo) {
        return cfg.regionIdFixo;
    }
    try {
        const url = `${cfg.host}/api/checkout/pub/regions?country=BRA&postalCode=${cep}`;
        const data = await buscarDadosComRetry(url, 1, cookies, cfg.binding || null);
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
// 5. FUNÇÕES AUXILIARES PARA EXTRAÇÃO DE DADOS
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
// 6. FUNÇÃO DE BUSCA GENÉRICA PARA QUALQUER LOJA
// ============================================================================
async function buscarProdutoNaLoja(host, regionId, sc, ean, produtoNome, sellersList, cookies = {}, binding = null) {
    // 1. Busca por EAN
    let url = `${host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}&sc=${sc}`;
    if (regionId) url += `&regionId=${regionId}`;
    url += `&_=${Date.now()}`;

    let dados = await buscarDadosComRetry(url, 1, cookies, binding);
    let sku = null, linkText = null, link = null;

    if (dados && dados.length > 0) {
        const info = extrairInfoProduto(dados);
        if (info) {
            sku = info.sku;
            linkText = info.linkText;
            link = info.link;
        }
        const precoDireto = extrairPrecoDireto(dados);
        if (precoDireto && precoDireto.preco > 0) {
            return { ...precoDireto, link };
        }
    }

    // 2. Fallback por nome
    if (!sku) {
        const nomeExato = encodeURIComponent(produtoNome);
        let urlNome = `${host}/api/catalog_system/pub/products/search?fq=productName:${nomeExato}&sc=${sc}`;
        if (regionId) urlNome += `&regionId=${regionId}`;
        urlNome += `&_=${Date.now()}`;
        dados = await buscarDadosComRetry(urlNome, 1, cookies, binding);
        if (dados && dados.length > 0) {
            const candidato = dados.find(p => p.productName && p.productName.toLowerCase().includes(produtoNome.toLowerCase()));
            if (candidato) {
                const info = extrairInfoProduto([candidato]);
                if (info) {
                    sku = info.sku;
                    linkText = info.linkText;
                    link = info.link;
                }
            }
        }
    }

    if (!sku) {
        return null;
    }

    // 3. Tenta cada seller em ordem (prioridade)
    if (sellersList && sellersList.length > 0) {
        for (const seller of sellersList) {
            const sim = await simularCarrinho(host, regionId, sku, seller, sc, cookies, binding);
            if (sim && sim.preco > 0) {
                return {
                    preco: sim.preco,
                    nomeLojaOrigem: `${seller}`,
                    sku: sku,
                    link: link || `https://${host}/${linkText}/p`,
                    seller: seller
                };
            }
        }
    }

    // 4. Fallback: simulação com seller '1'
    const simDefault = await simularCarrinho(host, regionId, sku, '1', sc, cookies, binding);
    if (simDefault && simDefault.preco > 0) {
        return {
            preco: simDefault.preco,
            nomeLojaOrigem: 'padrão',
            sku: sku,
            link: link || `https://${host}/${linkText}/p`,
            seller: '1'
        };
    }

    return null;
}

// ============================================================================
// 7. FUNÇÃO PRINCIPAL – AZURE FUNCTION (mesclada)
// ============================================================================
module.exports = async function (context, req) {
    // Configurações das lojas (Atacadão e Sam's Club)
    const configs = [
        {
            id: 'ATACADAO',
            nome: "Atacadão",
            host: 'https://www.atacadao.com.br',
            scList: [1, 2, 3],
            sellers: [
                'atacadaobr637', // prioridade
                'atacadaobr634',
                'atacadaobr649',
                'atacadaobr680',
                'atacadaobr697',
                'atacadaobr698',
                'atacadaobr938',
                'atacadaobr939'
            ],
            regionIdFixo: null, // obtém dinamicamente
            binding: null,
            usarCookies: false
        },
        {
            id: 'SAMS',
            nome: "Sam's Club",
            host: 'https://www.samsclub.com.br',
            scList: [1, 2, 3],
            sellers: [
                'samsclub6058', // prioridade (Sam's Club geral)
                'samsclub6546'  // Sam's Club Osasco
            ],
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

        // Obter cookies para lojas que precisam (Sam's Club)
        const cookiesMap = {};
        for (const cfg of configs) {
            if (cfg.usarCookies) {
                cookiesMap[cfg.id] = await obterCookiesSams(cfg.host);
                context.log(`Cookies obtidos para ${cfg.nome}:`, cookiesMap[cfg.id]);
            } else {
                cookiesMap[cfg.id] = {};
            }
        }

        // Obter regionId para cada loja (usa fixo se disponível)
        const regionIds = {};
        for (const cfg of configs) {
            regionIds[cfg.id] = await obterRegionIdPorLoja(cfg, CEP_PADRAO, cookiesMap[cfg.id] || {});
            context.log(`${cfg.nome} regionId: ${regionIds[cfg.id] || 'N/A'}`);
        }

        // Buscar produtos ativos
        const monitorados = await dicionarioCol.find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();
        if (monitorados.length === 0) {
            context.res = { status: 200, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        // Processar em lotes com delay entre eles
        const total = monitorados.length;
        for (let i = 0; i < total; i += CONCURRENT_LIMIT) {
            const batch = monitorados.slice(i, i + CONCURRENT_LIMIT);
            const batchPromises = batch.map(async (prod) => {
                const resultadosProduto = [];

                for (const cfg of configs) {
                    let encontrado = false;
                    const cookies = cookiesMap[cfg.id] || {};
                    for (const sc of cfg.scList) {
                        const regionId = regionIds[cfg.id];
                        const resultado = await buscarProdutoNaLoja(
                            cfg.host,
                            regionId,
                            sc,
                            prod.ean,
                            prod.nome_comum,
                            cfg.sellers,
                            cookies,
                            cfg.binding
                        );
                        if (resultado) {
                            const ultimoPrecoWeb = await obterUltimoPrecoValido(db, prod.nome_comum, cfg.nome);
                            const precoReferencia = prod.preco_alvo || ultimoPrecoWeb || Infinity;
                            const temAlvo = precoReferencia !== Infinity;

                            // Se tiver um seller preferido salvo no banco, usamos ele para acelerar
                            // Mas como é cache, não vamos implementar agora para simplificar

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

                            // Alertas e histórico (mantido igual)
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

            // Delay entre lotes para não sobrecarregar os servidores
            if (i + CONCURRENT_LIMIT < total) {
                context.log(`Aguardando ${DELAY_BETWEEN_BATCHES}ms antes do próximo lote...`);
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
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
// 8. FUNÇÃO AUXILIAR: OBTER ÚLTIMO PREÇO VÁLIDO
// ============================================================================
async function obterUltimoPrecoValido(db, nomeProduto, nomeLoja) {
    const ultimo = await db.collection('historico_precos_web')
        .find({ nome: nomeProduto, loja: nomeLoja, preco: { $gt: 0 } })
        .sort({ data_verificacao: -1 })
        .limit(1)
        .toArray();
    return ultimo.length > 0 ? ultimo[0].preco : Infinity;
}