const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// CONFIGURAÇÕES
// ============================================================================
const CEP_PADRAO = process.env.CEP_PADRAO || '06093085';
const TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

// Lista de sellers em ordem de prioridade (primeiro o que você quer priorizar)
const SELLERS_ATACADAO = [
    'atacadaobr637', // prioridade máxima
    'atacadaobr634',
    'atacadaobr649',
    'atacadaobr680',
    'atacadaobr697',
    'atacadaobr698',
    'atacadaobr938',
    'atacadaobr939'
];

// ============================================================================
// 1. OBTER REGIONID (com fallback e cache)
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
    return 'v2.B8DCB8B9A6E97811ED86748D0F84492B'; // fallback
}

// ============================================================================
// 2. REQUISIÇÃO COM RETRY E TIMEOUT (GET e POST)
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
// 3. FUNÇÃO PARA SIMULAR CARRINHO (POST)
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
// 4. EXTRAIR INFORMAÇÕES BÁSICAS DO PRODUTO (SKU, linkText)
// ============================================================================
function extrairInfoProduto(data) {
    if (!data || data.length === 0) return null;
    const item = data[0];
    if (!item.items || item.items.length === 0) return null;
    const variant = item.items[0];
    return {
        sku: variant.itemId,
        linkText: item.linkText,
        link: item.link || `https://www.atacadao.com.br/${item.linkText}/p`,
        name: item.productName
    };
}

// ============================================================================
// 5. EXTRAIR PREÇO DIRETO DA RESPOSTA DA API (fallback)
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
                        nomeLojaOrigem: seller.sellerName || 'Atacadão',
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
// 6. FUNÇÃO PRINCIPAL DE BUSCA COM PRIORIDADE E CACHE
// ============================================================================
async function buscarProdutoComCache(host, sc, regionId, ean, produtoNome, sellerPreferido) {
    // 1. Obter SKU e link via EAN (ou nome)
    let url = `${host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}&sc=${sc}&regionId=${regionId}&_=${Date.now()}`;
    let dados = await buscarDadosComRetry(url);
    let sku = null, linkText = null, link = null;

    if (dados && dados.length > 0) {
        const info = extrairInfoProduto(dados);
        if (info) {
            sku = info.sku;
            linkText = info.linkText;
            link = info.link;
        }
    }

    // Fallback por nome se não achou pelo EAN
    if (!sku) {
        const urlNome = `${host}/api/catalog_system/pub/products/search?fq=productName:${encodeURIComponent(produtoNome)}&sc=${sc}&regionId=${regionId}&_=${Date.now()}`;
        dados = await buscarDadosComRetry(urlNome);
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
        return null; // não encontrou o produto
    }

    // 2. Definir lista de sellers para tentar: primeiro o preferido (se existir), depois a lista padrão
    let sellersToTry = [];
    if (sellerPreferido && SELLERS_ATACADAO.includes(sellerPreferido)) {
        // Coloca o preferido no início, depois os demais (mantendo a ordem de prioridade)
        const others = SELLERS_ATACADAO.filter(s => s !== sellerPreferido);
        sellersToTry = [sellerPreferido, ...others];
    } else {
        sellersToTry = SELLERS_ATACADAO;
    }

    // 3. Tentar simulação com cada seller da lista
    for (const seller of sellersToTry) {
        const sim = await simularCarrinho(host, regionId, sku, seller, sc);
        if (sim && sim.preco > 0) {
            return {
                preco: sim.preco,
                nomeLojaOrigem: `Atacadão (${seller})`,
                sku: sku,
                link: link,
                seller: seller
            };
        }
    }

    // 4. Fallback: extrair preço direto da API (pode ser ATACADAO SA)
    if (dados) {
        const precoDireto = extrairPrecoDireto(dados);
        if (precoDireto) {
            return { ...precoDireto, link };
        }
    }

    return null;
}

// ============================================================================
// 7. FUNÇÃO AUXILIAR: OBTER ÚLTIMO PREÇO VÁLIDO
// ============================================================================
async function obterUltimoPrecoValido(db, nomeProduto, nomeLoja) {
    const ultimo = await db.collection('historico_precos_web')
        .find({ nome: nomeProduto, loja: nomeLoja, preco: { $gt: 0 } })
        .sort({ data_verificacao: -1 })
        .limit(1)
        .toArray();
    return ultimo.length > 0 ? ultimo[0].preco : null;
}

// ============================================================================
// 8. FUNÇÃO PRINCIPAL – AZURE FUNCTION
// ============================================================================
module.exports = async function (context, req) {
    const configs = [
        {
            id: 'ATACADAO',
            nome: "Atacadão",
            host: 'https://www.atacadao.com.br',
            scList: [1, 2, 3] // prioridade: sc=1, depois 2, 3
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

        // Busca produtos ativos com EAN
        const monitorados = await dicionarioCol.find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();
        if (monitorados.length === 0) {
            context.res = { status: 200, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        for (const prod of monitorados) {
            const produtoNome = prod.nome_comum;
            const ean = prod.ean;
            // Recupera o seller preferido armazenado (se houver)
            const sellerPreferido = prod.seller_preferido || null;
            let resultadoLoja = null;

            // Tenta cada SC
            for (const lojaConfig of configs) {
                for (const sc of lojaConfig.scList) {
                    const resultado = await buscarProdutoComCache(
                        lojaConfig.host,
                        sc,
                        regionId,
                        ean,
                        produtoNome,
                        sellerPreferido
                    );
                    if (resultado) {
                        resultadoLoja = {
                            produto: produtoNome,
                            loja: lojaConfig.nome,
                            origem: resultado.nomeLojaOrigem || resultado.seller || 'Atacadão',
                            link: resultado.link,
                            preco: resultado.preco,
                            sku: resultado.sku,
                            seller: resultado.seller
                        };
                        break;
                    }
                }
                if (resultadoLoja) break;
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

            // Atualiza o cache do seller preferido no banco
            if (resultadoLoja.seller && resultadoLoja.seller !== sellerPreferido) {
                await dicionarioCol.updateOne(
                    { _id: prod._id },
                    { $set: { seller_preferido: resultadoLoja.seller } }
                );
                context.log(`Seller preferido atualizado para ${produtoNome}: ${resultadoLoja.seller}`);
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

            // Disparo de alerta (se preço abaixo do alvo ou último preço)
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

            // Salva histórico se houve mudança
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