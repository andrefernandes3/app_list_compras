const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// CONFIGURAÇÕES GERAIS
// ============================================================================
const CEP_PADRAO = process.env.CEP_PADRAO || '06093085';
const TIMEOUT_MS = 10000; // 10 segundos
const MAX_RETRIES = 2;

// Lista de sellers para Atacadão (prioridade)
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

// Lista de sellers para Sam's Club (apenas os mais comuns)
const SELLERS_SAMS = ['1', '2']; // sellers padrão

// ============================================================================
// 1. FUNÇÃO: REQUISIÇÃO COM RETRY E TIMEOUT (melhorada)
// ============================================================================
function buscarDadosComTimeout(url, tentativa = 1) {
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
                return resolve(buscarDadosComTimeout(novaUrl, tentativa));
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
                setTimeout(() => resolve(buscarDadosComTimeout(url, tentativa + 1)), 500);
            } else resolve(null);
        });

        req.on('error', () => {
            if (tentativa < MAX_RETRIES) {
                setTimeout(() => resolve(buscarDadosComTimeout(url, tentativa + 1)), 500);
            } else resolve(null);
        });

        req.end();
    });
}

// ============================================================================
// 2. FUNÇÃO: OBTER REGIONID (cache)
// ============================================================================
let regionIdCache = { value: null, timestamp: 0 };

async function obterRegionId(cep) {
    const agora = Date.now();
    if (regionIdCache.value && (agora - regionIdCache.timestamp) < 3600000) {
        return regionIdCache.value;
    }

    try {
        const url = `https://www.atacadao.com.br/api/checkout/pub/regions?country=BRA&postalCode=${cep}`;
        const data = await buscarDadosComTimeout(url);
        if (data && data.length > 0) {
            const region = data.find(r => r.id && r.id.startsWith('v2.'));
            const id = region ? region.id : data[0].id;
            if (id) {
                regionIdCache = { value: id, timestamp: agora };
                return id;
            }
        }
    } catch (e) {}
    return 'v2.B8DCB8B9A6E97811ED86748D0F84492B'; // fallback
}

// ============================================================================
// 3. FUNÇÕES AUXILIARES PARA EXTRAÇÃO E SIMULAÇÃO
// ============================================================================

// Extrai informações básicas (SKU, linkText) da resposta da API
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

// Extrai preço direto da API (primeiro seller com preço > 0)
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
                        seller: seller.sellerId,
                        link: item.link || ''
                    };
                }
            }
        }
    }
    return null;
}

// Simulação de carrinho para obter preço com seller específico
async function simularCarrinho(host, regionId, sku, sellerId, sc = 1) {
    const url = `${host}/api/checkout/pub/orderForms/simulation?sc=${sc}`;
    const payload = {
        items: [{ id: sku, quantity: 1, seller: sellerId }],
        regionId: regionId,
        country: 'BRA'
    };

    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
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
// 4. FUNÇÕES DE BUSCA POR LOJA
// ============================================================================

// --- BUSCA ATACADÃO (com prioridade de seller e fallback) ---
async function buscarAtacadao(host, sc, regionId, ean, produtoNome) {
    // Primeiro tenta obter SKU via EAN
    let url = `${host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}&sc=${sc}&regionId=${regionId}&_=${Date.now()}`;
    let dados = await buscarDadosComTimeout(url);
    let sku = null, linkText = null, link = null;

    if (dados && dados.length > 0) {
        const info = extrairInfoProduto(dados);
        if (info) {
            sku = info.sku;
            linkText = info.linkText;
            link = info.link;
        }
    }

    // Fallback: busca por nome se EAN falhar
    if (!sku) {
        const urlNome = `${host}/api/catalog_system/pub/products/search?fq=productName:${encodeURIComponent(produtoNome)}&sc=${sc}&regionId=${regionId}&_=${Date.now()}`;
        dados = await buscarDadosComTimeout(urlNome);
        if (dados && dados.length > 0) {
            const info = extrairInfoProduto(dados);
            if (info) {
                sku = info.sku;
                linkText = info.linkText;
                link = info.link;
            }
        }
    }

    if (!sku) return null;

    // Tenta simulação com cada seller da lista (prioridade)
    for (const seller of SELLERS_ATACADAO) {
        const sim = await simularCarrinho(host, regionId, sku, seller, sc);
        if (sim && sim.preco > 0) {
            return {
                preco: sim.preco,
                nomeLojaOrigem: `Atacadão (${seller})`,
                sku: sku,
                link: link || `https://www.atacadao.com.br/${linkText}/p`,
                seller: seller
            };
        }
    }

    // Fallback: extração direta da API (pode ser ATACADAO SA)
    if (dados) {
        const direto = extrairPrecoDireto(dados);
        if (direto) return { ...direto, link: link || direto.link };
    }

    return null;
}

// --- BUSCA SAM'S CLUB (simples) ---
async function buscarSamsClub(host, sc, regionId, ean, produtoNome) {
    let url = `${host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}&sc=${sc}&regionId=${regionId}&_=${Date.now()}`;
    let dados = await buscarDadosComTimeout(url);
    let sku = null, linkText = null, link = null;

    if (dados && dados.length > 0) {
        const info = extrairInfoProduto(dados);
        if (info) {
            sku = info.sku;
            linkText = info.linkText;
            link = info.link;
        }
        // Tenta extrair preço direto
        const direto = extrairPrecoDireto(dados);
        if (direto) return { ...direto, link: link || direto.link };
    }

    // Se não achou preço direto, tenta simulação com sellers padrão
    if (sku) {
        for (const seller of SELLERS_SAMS) {
            const sim = await simularCarrinho(host, regionId, sku, seller, sc);
            if (sim && sim.preco > 0) {
                return {
                    preco: sim.preco,
                    nomeLojaOrigem: `Sam's Club (seller ${seller})`,
                    sku: sku,
                    link: link || `https://www.samsclub.com.br/${linkText}/p`,
                    seller: seller
                };
            }
        }
    }

    return null;
}

// ============================================================================
// 5. FUNÇÃO PRINCIPAL
// ============================================================================
module.exports = async function (context, req) {
    // Configurações: apenas Atacadão e Sam's Club (Carrefour removido temporariamente)
    const configs = [
        { 
            id: 'SAMS', 
            nome: "Sam's Club", 
            host: 'https://www.samsclub.com.br', 
            regionId: '', 
            scList: [1, 2, 3] // tenta vários sc
        },
        { 
            id: 'ATACADAO', 
            nome: "Atacadão", 
            host: 'https://www.atacadao.com.br', 
            regionId: '', // será obtido dinamicamente
            scList: [1, 2, 3] // tenta vários sc, mas prioriza 1
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

        // Obtém regionId para Atacadão (será usado também para outras lojas se não tiverem)
        const regionIdAtacadao = await obterRegionId(CEP_PADRAO);
        context.log(`RegionId Atacadão: ${regionIdAtacadao}`);

        // Busca produtos ativos
        const monitorados = await dicionarioCol.find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();
        if (monitorados.length === 0) {
            context.res = { status: 200, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        for (const prod of monitorados) {
            // Para cada produto, busca em cada loja configurada
            const promessasBusca = configs.map(async (lojaConfig) => {
                try {
                    // Determina regionId: se a loja tem regionId próprio, usa; senão usa o do Atacadão (fallback)
                    let regionId = lojaConfig.regionId || regionIdAtacadao;
                    let ultimoPrecoWeb = await obterUltimoPrecoValido(db, prod.nome_comum, lojaConfig.nome);
                    let precoReferencia = prod.preco_alvo || ultimoPrecoWeb;
                    let temAlvo = precoReferencia !== Infinity;

                    let resultado = null;

                    // Tenta cada SC da lista
                    for (const sc of lojaConfig.scList) {
                        if (lojaConfig.id === 'ATACADAO') {
                            resultado = await buscarAtacadao(lojaConfig.host, sc, regionId, prod.ean, prod.nome_comum);
                        } else if (lojaConfig.id === 'SAMS') {
                            resultado = await buscarSamsClub(lojaConfig.host, sc, regionId, prod.ean, prod.nome_comum);
                        }
                        if (resultado) break;
                    }

                    if (!resultado) {
                        return {
                            produto: prod.nome_comum,
                            loja: lojaConfig.nome,
                            origem: "N/A",
                            status: "NÃO ENCONTRADO",
                            preco: 0,
                            precoReferencia,
                            ultimoPrecoWeb,
                            temAlvo,
                            link: ""
                        };
                    }

                    return {
                        produto: prod.nome_comum,
                        loja: lojaConfig.nome,
                        origem: resultado.nomeLojaOrigem || "N/A",
                        link: resultado.link || "",
                        status: resultado.preco > 0 ? "ENCONTRADO" : "SEM ESTOQUE (Preço 0,00)",
                        preco: resultado.preco,
                        precoReferencia,
                        ultimoPrecoWeb,
                        temAlvo,
                        seller: resultado.seller || null
                    };

                } catch (err) {
                    return {
                        produto: prod.nome_comum,
                        loja: lojaConfig.nome,
                        origem: "ERRO",
                        status: "ERRO DE CONEXÃO",
                        preco: 0,
                        precoReferencia: null,
                        ultimoPrecoWeb: null,
                        temAlvo: false,
                        link: ""
                    };
                }
            });

            const resultadosDoProduto = await Promise.all(promessasBusca);

            // Processa cada resultado
            for (const res of resultadosDoProduto) {
                // Monta entrada no relatório
                relatorio.push({
                    produto: res.produto,
                    loja: res.loja,
                    origem: res.origem,
                    status: res.status,
                    ...(res.preco > 0 && { preco: res.preco, referencia_usada: res.precoReferencia })
                });

                if (res.status === "ENCONTRADO" && res.preco > 0) {
                    // Alerta se preço baixou
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

                    // Salva histórico se houve mudança
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

                    // Cache do seller (opcional) – pode salvar no dicionario_produtos
                    if (res.seller) {
                        await dicionarioCol.updateOne(
                            { _id: prod._id },
                            { $set: { [`seller_${res.loja.replace(/\s/g,'_')}`]: res.seller } }
                        );
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
// FUNÇÃO AUXILIAR: OBTER ÚLTIMO PREÇO VÁLIDO
// ============================================================================
async function obterUltimoPrecoValido(db, nomeProduto, nomeLoja) {
    const ultimo = await db.collection('historico_precos_web')
        .find({ nome: nomeProduto, loja: nomeLoja, preco: { $gt: 0 } })
        .sort({ data_verificacao: -1 })
        .limit(1)
        .toArray();
    return ultimo.length > 0 ? ultimo[0].preco : Infinity;
}