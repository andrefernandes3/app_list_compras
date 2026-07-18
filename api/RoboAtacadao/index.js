const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// CONFIGURAÇÕES
// ============================================================================
const CEP_PADRAO = process.env.CEP_PADRAO || '06093085';
const TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

// ============================================================================
// 1. FUNÇÃO: OBTER REGIONID (com fallback)
// ============================================================================
let regionIdCache = { value: null, timestamp: 0 };

async function obterRegionId(cep) {
    const agora = Date.now();
    if (regionIdCache.value && (agora - regionIdCache.timestamp) < 3600000) {
        return regionIdCache.value;
    }

    try {
        const url = `https://www.atacadao.com.br/api/checkout/pub/regions?country=BRA&postalCode=${cep}`;
        const data = await buscarDadosComRetry(url);
        if (data && data.length > 0) {
            const region = data.find(r => r.id && r.id.startsWith('v2.'));
            const id = region ? region.id : data[0].id;
            if (id) {
                regionIdCache = { value: id, timestamp: agora };
                return id;
            }
        }
    } catch (e) {
        console.warn('Falha ao obter regionId, usando fallback fixo.', e.message);
    }
    // Fallback para o ID que você encontrou
    return 'v2.B8DCB8B9A6E97811ED86748D0F84492B';
}

// ============================================================================
// 2. FUNÇÃO: REQUISIÇÃO COM RETRY E TIMEOUT
// ============================================================================
function buscarDadosComRetry(url, tentativa = 1) {
    return new Promise((resolve) => {
        const urlObj = new URL(url);
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

        const req = https.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let novaUrl = res.headers.location;
                if (novaUrl.startsWith('/')) novaUrl = `https://${urlObj.hostname}${novaUrl}`;
                return resolve(buscarDadosComRetry(novaUrl, tentativa));
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
                resolve(buscarDadosComRetry(url, tentativa + 1));
            } else resolve(null);
        });

        req.on('error', (err) => {
            if (tentativa < MAX_RETRIES) {
                console.warn(`Erro na tentativa ${tentativa}: ${err.message}, tentando novamente...`);
                resolve(buscarDadosComRetry(url, tentativa + 1));
            } else resolve(null);
        });

        req.end();
    });
}

// ============================================================================
// 3. FUNÇÃO: EXTRAIR PREÇO DE UM PRODUTO (varre todos sellers)
// ============================================================================
function extrairPrecoDoItem(produtoData) {
    if (!produtoData || produtoData.length === 0) return null;

    // Percorre todos os items (variações)
    for (const item of produtoData) {
        if (!item.items) continue;
        for (const variant of item.items) {
            if (!variant.sellers) continue;
            // Varre todos os sellers e pega o primeiro com preço > 0
            for (const seller of variant.sellers) {
                const offer = seller.commertialOffer;
                if (offer && offer.Price > 0) {
                    return {
                        preco: offer.Price,
                        nomeLojaOrigem: seller.sellerName || 'Atacadão',
                        link: item.link || `https://www.atacadao.com.br/${item.linkText}/p`,
                        sku: variant.itemId,
                        sellerId: seller.sellerId,
                        availableQuantity: offer.AvailableQuantity || 0
                    };
                }
            }
        }
    }
    return null; // nenhum seller com preço > 0
}

// ============================================================================
// 4. FUNÇÃO: BUSCAR PRODUTO POR EAN (com fallback por linkText)
// ============================================================================
async function buscarProduto(host, sc, regionId, ean, nomeProduto, linkText) {
    // Tenta por EAN
    let url = `${host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}`;
    if (sc) url += `&sc=${sc}`;
    if (regionId) url += `&regionId=${regionId}`;
    url += `&_=${Date.now()}`;

    let dados = await buscarDadosComRetry(url);
    if (dados && dados.length > 0) {
        const extraido = extrairPrecoDoItem(dados);
        if (extraido) return extraido;
    }

    // Fallback: busca por linkText (se fornecido)
    if (linkText) {
        const urlLink = `${host}/api/catalog_system/pub/products/search?fq=linkText:${linkText}`;
        const scParam = sc ? `&sc=${sc}` : '';
        const regionParam = regionId ? `&regionId=${regionId}` : '';
        const urlCompleta = urlLink + scParam + regionParam + `&_=${Date.now()}`;
        dados = await buscarDadosComRetry(urlCompleta);
        if (dados && dados.length > 0) {
            const extraido = extrairPrecoDoItem(dados);
            if (extraido) return extraido;
        }
    }

    return null;
}

// ============================================================================
// 5. FUNÇÃO: SIMULAR CARRINHO PARA OBTER PREÇO (fallback extremo)
// ============================================================================
async function simularCarrinho(host, regionId, sku, sellerId, sc = 1) {
    const url = `${host}/api/checkout/pub/orderForms/simulation?sc=${sc}`;
    const payload = {
        items: [{ id: sku, quantity: 1, seller: sellerId || '1' }],
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
                        if (item.price > 0) {
                            resolve({
                                preco: item.price / 100, // geralmente vem em centavos
                                seller: item.seller,
                                available: item.availability === 'available'
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
// 6. FUNÇÃO PRINCIPAL – AZURE FUNCTION
// ============================================================================
module.exports = async function (context, req) {
    const configs = [
        {
            id: 'ATACADAO',
            nome: "Atacadão",
            host: 'https://www.atacadao.com.br',
            scList: [1, 2, 3, null] // tenta vários
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

        const regionId = await obterRegionId(CEP_PADRAO);
        context.log(`RegionId usado: ${regionId}`);

        const monitorados = await dicionarioCol.find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();
        if (monitorados.length === 0) {
            context.res = { status: 200, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        for (const prod of monitorados) {
            const produtoNome = prod.nome_comum;
            const ean = prod.ean;
            const linkText = prod.link_text || null; // se tiver armazenado no banco
            let resultadoLoja = null;

            for (const lojaConfig of configs) {
                for (const sc of lojaConfig.scList) {
                    const dadosExtraidos = await buscarProduto(
                        lojaConfig.host,
                        sc,
                        regionId,
                        ean,
                        produtoNome,
                        linkText
                    );
                    if (dadosExtraidos) {
                        resultadoLoja = dadosExtraidos;
                        resultadoLoja.loja = lojaConfig.nome;
                        resultadoLoja.produto = produtoNome;
                        break;
                    }
                }
                if (resultadoLoja) break;
            }

            // Se ainda não encontrou, tenta simulação de carrinho (fallback)
            if (!resultadoLoja) {
                // Tenta buscar o SKU via busca por nome (para obter o ID)
                const urlNome = `https://www.atacadao.com.br/api/catalog_system/pub/products/search?fq=productName:${encodeURIComponent(produtoNome)}&regionId=${regionId}&_=${Date.now()}`;
                const dadosNome = await buscarDadosComRetry(urlNome);
                if (dadosNome && dadosNome.length > 0) {
                    const item = dadosNome[0];
                    if (item.items && item.items.length > 0) {
                        const sku = item.items[0].itemId;
                        const sim = await simularCarrinho('https://www.atacadao.com.br', regionId, sku, null, 1);
                        if (sim && sim.preco > 0) {
                            resultadoLoja = {
                                produto: produtoNome,
                                loja: 'Atacadão',
                                origem: sim.seller || 'Atacadão',
                                link: item.link || '',
                                preco: sim.preco,
                                sku: sku
                            };
                        }
                    }
                }
            }

            if (!resultadoLoja) {
                relatorio.push({
                    produto: produtoNome,
                    loja: 'Atacadão',
                    origem: 'N/A',
                    status: 'NÃO ENCONTRADO OU SEM ESTOQUE',
                    preco: 0,
                    referencia_usada: null,
                    ultimoPrecoWeb: null,
                    link: ''
                });
                continue;
            }

            const precoAtual = resultadoLoja.preco;
            const ultimoPrecoWeb = await obterUltimoPrecoValido(db, produtoNome, 'Atacadão');
            const precoReferencia = prod.preco_alvo || ultimoPrecoWeb || Infinity;
            const temAlvo = precoReferencia !== Infinity;

            const entry = {
                produto: produtoNome,
                loja: 'Atacadão',
                origem: resultadoLoja.origem || 'N/A',
                status: precoAtual > 0 ? 'ENCONTRADO' : 'SEM ESTOQUE (Preço 0,00)',
                preco: precoAtual,
                referencia_usada: temAlvo ? precoReferencia : null,
                ultimoPrecoWeb: ultimoPrecoWeb,
                link: resultadoLoja.link || ''
            };
            relatorio.push(entry);

            // Alerta e histórico...
            if (precoAtual > 0 && temAlvo && precoAtual < precoReferencia) {
                const jaExiste = await alertasCol.findOne({
                    produto_nome: produtoNome,
                    loja: 'Atacadão',
                    preco_atual: precoAtual,
                    status_notificacao: 'pendente'
                });
                if (!jaExiste) {
                    await alertasCol.insertOne({
                        produto_nome: produtoNome,
                        loja: 'Atacadão',
                        preco_historico: precoReferencia,
                        preco_atual: precoAtual,
                        link_compra: resultadoLoja.link,
                        data_alerta: new Date(),
                        status_notificacao: 'pendente'
                    });
                }
            }

            if (ultimoPrecoWeb === null || precoAtual !== ultimoPrecoWeb) {
                await db.collection('historico_precos_web').insertOne({
                    nome: produtoNome,
                    ean: prod.ean,
                    loja: 'Atacadão',
                    origem: resultadoLoja.origem || 'N/A',
                    preco: precoAtual,
                    data_verificacao: new Date()
                });
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
            body: { erro: 'Erro Crítico: ' + e.message }
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
    return ultimo.length > 0 ? ultimo[0].preco : null;
}