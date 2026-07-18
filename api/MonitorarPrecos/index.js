const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// CONFIGURAÇÕES GERAIS
// ============================================================================
const CEP_PADRAO = process.env.CEP_PADRAO || '06093085';
const TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

// Lista de sellers (filiais) do Atacadão em ordem de prioridade
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
// 1. FUNÇÕES PARA O ATACADÃO (COM REGIONID DINÂMICO E SIMULAÇÃO)
// ============================================================================

// Cache do regionId
let regionIdCache = { value: null, timestamp: 0 };

async function obterRegionId(cep) {
    const agora = Date.now();
    if (regionIdCache.value && (agora - regionIdCache.timestamp) < 3600000) {
        return regionIdCache.value;
    }

    try {
        const url = `https://www.atacadao.com.br/api/checkout/pub/regions?country=BRA&postalCode=${cep}`;
        const data = await buscarDadosVtex(url); // reutiliza a função existente
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

// Função para simular carrinho no Atacadão
async function simularCarrinhoAtacadao(host, regionId, sku, sellerId, sc = 1) {
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

// Função para extrair informações básicas (SKU, linkText) da resposta da API
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

// Função para extrair preço direto da resposta (fallback)
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

// Função principal de busca para o Atacadão (com prioridade de seller e cache)
async function buscarProdutoAtacadao(host, sc, regionId, ean, produtoNome, sellerPreferido = null) {
    // 1. Busca por EAN para obter SKU e link
    let url = `${host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}&sc=${sc}&regionId=${regionId}&_=${Date.now()}`;
    let dados = await buscarDadosVtex(url);

    let sku = null;
    let linkText = null;
    let link = null;

    if (dados && dados.length > 0) {
        const info = extrairInfoProduto(dados);
        if (info) {
            sku = info.sku;
            linkText = info.linkText;
            link = info.link;
        }
    }

    // Se não achou pelo EAN, tenta por nome (fallback)
    if (!sku) {
        const urlNome = `${host}/api/catalog_system/pub/products/search?fq=productName:${encodeURIComponent(produtoNome)}&sc=${sc}&regionId=${regionId}&_=${Date.now()}`;
        dados = await buscarDadosVtex(urlNome);
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
        return null; // não encontrou o SKU
    }

    // 2. Monta lista de sellers para tentar: primeiro o preferido (se houver), depois a lista padrão
    let sellersToTry = [];
    if (sellerPreferido && SELLERS_ATACADAO.includes(sellerPreferido)) {
        sellersToTry = [sellerPreferido, ...SELLERS_ATACADAO.filter(s => s !== sellerPreferido)];
    } else {
        sellersToTry = SELLERS_ATACADAO;
    }

    // 3. Tenta simulação para cada seller (em ordem de prioridade)
    for (const seller of sellersToTry) {
        const sim = await simularCarrinhoAtacadao(host, regionId, sku, seller, sc);
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

    // 4. Fallback: se nenhum seller da lista funcionou, tenta extrair preço direto da API (pode ser ATACADAO SA)
    if (dados) {
        const precoDireto = extrairPrecoDireto(dados);
        if (precoDireto) {
            return { ...precoDireto, link };
        }
    }

    return null;
}

// ============================================================================
// 2. FUNÇÕES COMPARTILHADAS (já existentes)
// ============================================================================

// Buscar dados VTEX (com retry e timeout aprimorados)
const buscarDadosVtex = (targetUrl, tentativa = 1) => {
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
            if (res.statusCode !== 200) return resolve(null);

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve(null); }
            });
        });

        reqHttp.on('timeout', () => {
            reqHttp.destroy();
            if (tentativa < MAX_RETRIES) {
                console.warn(`Timeout na tentativa ${tentativa}, tentando novamente...`);
                resolve(buscarDadosVtex(targetUrl, tentativa + 1));
            } else resolve(null);
        });

        reqHttp.on('error', () => {
            if (tentativa < MAX_RETRIES) {
                console.warn(`Erro na tentativa ${tentativa}, tentando novamente...`);
                resolve(buscarDadosVtex(targetUrl, tentativa + 1));
            } else resolve(null);
        });

        reqHttp.end();
    });
};

// Obter último preço válido (mantido igual)
async function obterUltimoPrecoValido(db, nomeProduto, nomeLoja) {
    const ultimoRegistro = await db.collection('historico_precos_web')
        .find({ nome: nomeProduto, loja: nomeLoja, preco: { $gt: 0 } })
        .sort({ data_verificacao: -1 })
        .limit(1)
        .toArray();
    if (ultimoRegistro.length === 0) return Infinity;
    return ultimoRegistro[0].preco;
}

// ============================================================================
// 3. FUNÇÃO PRINCIPAL (AZURE FUNCTION)
// ============================================================================
module.exports = async function (context, req) {
    const configs = [
        { id: 'SAMS', nome: "Sam's Club", host: 'https://www.samsclub.com.br', regionId: '', sc: '1' },
        { id: 'CARREFOUR', nome: "Carrefour", host: 'https://www.carrefour.com.br', regionId: '', sc: '1' },
        {
            id: 'ATACADAO',
            nome: "Atacadão",
            host: 'https://www.atacadao.com.br',
            regionId: '', // será obtido dinamicamente
            sc: '1'
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

        // Obtém regionId para o Atacadão (uma vez para toda execução)
        const regionIdAtacadao = await obterRegionId(CEP_PADRAO);
        context.log(`RegionId do Atacadão: ${regionIdAtacadao}`);

        // Busca produtos ativos com EAN
        const monitorados = await dicionarioCol.find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();
        if (monitorados.length === 0) {
            context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        for (const prod of monitorados) {
            // Para cada produto, busca o seller preferido salvo no banco (cache)
            const sellerPreferido = prod.seller_preferido || null;

            // Mapeia as promessas de busca para cada loja
            const promessasBusca = configs.map(async (lojaConfig) => {
                try {
                    const ultimoPrecoWeb = await obterUltimoPrecoValido(db, prod.nome_comum, lojaConfig.nome);
                    const precoReferencia = prod.preco_alvo || ultimoPrecoWeb;
                    const temAlvo = precoReferencia !== Infinity;

                    let resultado = null;

                    if (lojaConfig.id === 'ATACADAO') {
                        // Usa a lógica aprimorada para o Atacadão
                        const sc = parseInt(lojaConfig.sc) || 1;
                        const dadosExtraidos = await buscarProdutoAtacadao(
                            lojaConfig.host,
                            sc,
                            regionIdAtacadao,
                            prod.ean,
                            prod.nome_comum,
                            sellerPreferido
                        );
                        if (dadosExtraidos) {
                            resultado = {
                                produto: prod.nome_comum,
                                loja: lojaConfig.nome,
                                origem: dadosExtraidos.nomeLojaOrigem,
                                link: dadosExtraidos.link,
                                status: dadosExtraidos.preco > 0 ? "ENCONTRADO" : "SEM ESTOQUE (Preço 0,00)",
                                preco: dadosExtraidos.preco,
                                precoReferencia,
                                ultimoPrecoWeb,
                                temAlvo,
                                seller: dadosExtraidos.seller // guarda o seller usado
                            };
                        } else {
                            resultado = {
                                produto: prod.nome_comum,
                                loja: lojaConfig.nome,
                                origem: "N/A",
                                status: "NÃO ENCONTRADO",
                                preco: 0,
                                precoReferencia,
                                ultimoPrecoWeb,
                                temAlvo
                            };
                        }
                    } else {
                        // Lógica original para Sam's Club e Carrefour (busca simples)
                        let urlEan = `${lojaConfig.host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${prod.ean}&sc=${lojaConfig.sc}&_=${Date.now()}`;
                        if (lojaConfig.regionId) urlEan += `&regionId=${lojaConfig.regionId}`;

                        const data = await buscarDadosVtex(urlEan);

                        if (data && data.length > 0) {
                            const item = data[0];
                            let precoAtual = 0;
                            let linkCompra = item.link;
                            let nomeLojaOrigem = "N/A";

                            for (const seller of item.items[0].sellers) {
                                if (seller.commertialOffer.Price > 0) {
                                    precoAtual = seller.commertialOffer.Price;
                                    nomeLojaOrigem = seller.sellerName;
                                    break;
                                }
                            }

                            resultado = {
                                produto: prod.nome_comum,
                                loja: lojaConfig.nome,
                                origem: nomeLojaOrigem,
                                link: linkCompra,
                                status: precoAtual > 0 ? "ENCONTRADO" : "SEM ESTOQUE (Preço 0,00)",
                                preco: precoAtual,
                                precoReferencia,
                                ultimoPrecoWeb,
                                temAlvo
                            };
                        } else {
                            resultado = {
                                produto: prod.nome_comum,
                                loja: lojaConfig.nome,
                                origem: "N/A",
                                status: "NÃO ENCONTRADO",
                                preco: 0,
                                precoReferencia,
                                ultimoPrecoWeb,
                                temAlvo
                            };
                        }
                    }

                    return resultado;
                } catch (err) {
                    return {
                        produto: prod.nome_comum,
                        loja: lojaConfig.nome,
                        origem: "ERRO",
                        status: "ERRO DE CONEXÃO",
                        preco: 0,
                        precoReferencia: Infinity,
                        ultimoPrecoWeb: Infinity,
                        temAlvo: false
                    };
                }
            });

            const resultadosDoProduto = await Promise.all(promessasBusca);

            for (const res of resultadosDoProduto) {
                // Adiciona ao relatório
                relatorio.push({
                    produto: res.produto,
                    loja: res.loja,
                    origem: res.origem,
                    status: res.status,
                    ...(res.preco > 0 && { preco: res.preco, referencia_usada: res.precoReferencia })
                });

                // Se for Atacadão e encontrou com um seller, atualiza o cache no banco
                if (res.loja === 'Atacadão' && res.status === 'ENCONTRADO' && res.seller) {
                    await dicionarioCol.updateOne(
                        { _id: prod._id },
                        { $set: { seller_preferido: res.seller } }
                    );
                }

                // Disparo de alertas e salvamento de histórico (lógica original)
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
        context.log.error('Erro crítico:', e);
        context.res = {
            status: 500,
            headers: { "Content-Type": "application/json" },
            body: { erro: "Erro Crítico: " + e.message }
        };
    } finally {
        if (client) await client.close();
    }
};