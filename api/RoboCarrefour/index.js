const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// FUNÇÃO AUXILIAR: REQUISIÇÃO HTTPS (com redirecionamento)
// ============================================================================
const request = (url, options = {}) => {
    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const reqOptions = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                ...options.headers
            },
            ...options
        };

        const reqHttp = https.request(reqOptions, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let novaUrl = res.headers.location;
                if (novaUrl.startsWith('/')) novaUrl = `https://${urlObj.hostname}${novaUrl}`;
                return resolve(request(novaUrl, options));
            }
            if (res.statusCode !== 200) {
                return resolve({ status: res.statusCode, data: null });
            }

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ status: 200, data: json });
                } catch (e) {
                    // Se não for JSON, retorna o HTML como string
                    resolve({ status: 200, data: data });
                }
            });
        });

        reqHttp.on('error', () => resolve({ status: 500, data: null }));
        reqHttp.end();
    });
};

// ============================================================================
// 1. BUSCAR ÚLTIMO PREÇO HISTÓRICO
// ============================================================================
async function obterUltimoPrecoValido(db, nomeProduto, nomeLoja) {
    const ultimoRegistro = await db.collection('historico_precos_web')
        .find({ nome: nomeProduto, loja: nomeLoja, preco: { $gt: 0 } })
        .sort({ data_verificacao: -1 })
        .limit(1)
        .toArray();
    return ultimoRegistro.length === 0 ? Infinity : ultimoRegistro[0].preco;
}

// ============================================================================
// 2. EXTRAIR PREÇO DO HTML (JSON-LD ou microdados)
// ============================================================================
function extrairPrecoDoHTML(html) {
    try {
        // Tenta encontrar JSON-LD com @type = Product
        const jsonLdRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
        let match;
        while ((match = jsonLdRegex.exec(html)) !== null) {
            try {
                const json = JSON.parse(match[1]);
                if (json && json.offers && json.offers.price) {
                    return parseFloat(json.offers.price);
                }
                // Se for um array, verifica cada item
                if (Array.isArray(json)) {
                    for (const item of json) {
                        if (item.offers && item.offers.price) {
                            return parseFloat(item.offers.price);
                        }
                    }
                }
            } catch (e) { /* ignora */ }
        }

        // Tenta extrair do atributo data-price (comum em VTEX)
        const priceRegex = /data-price="?([0-9,.]+)"?/;
        const matchPrice = html.match(priceRegex);
        if (matchPrice) {
            return parseFloat(matchPrice[1].replace(',', '.'));
        }

        // Tenta encontrar span com classe de preço (genérico)
        const spanRegex = /<span[^>]*class="[^"]*price[^"]*"[^>]*>([0-9,.]+)<\/span>/i;
        const spanMatch = html.match(spanRegex);
        if (spanMatch) {
            return parseFloat(spanMatch[1].replace(',', '.'));
        }

        return null;
    } catch (e) {
        return null;
    }
}

// ============================================================================
// 3. FUNÇÃO PRINCIPAL
// ============================================================================
module.exports = async function (context, req) {
    // Configurações para tentar diferentes hosts e regionIds
    const hosts = [
        { host: 'https://mercado.carrefour.com.br', regionId: '' },
        { host: 'https://www.carrefour.com.br', regionId: '' }
        // Se descobrir um regionId, adicione aqui como {'host': ..., 'regionId': 'v2.xxx'}
    ];

    const sc = '1';
    const camposBusca = ['productId', 'skuId', 'alternateIds_RefId', 'id'];

    let client = null;
    let relatorio = [];

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        const dicionarioCol = db.collection('dicionario_produtos');
        const alertasCol = db.collection('alertas_preco');

        // Busca produtos ativos
        const monitorados = await dicionarioCol.find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();

        if (monitorados.length === 0) {
            context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        for (const prod of monitorados) {
            const ultimoPrecoWeb = await obterUltimoPrecoValido(db, prod.nome_comum, "Carrefour");
            const precoReferencia = prod.preco_alvo || ultimoPrecoWeb;
            const temAlvo = precoReferencia !== Infinity;

            let dados = null;
            let precoEncontrado = null;
            let linkCompra = null;
            let origem = "N/A";
            let metodoUsado = "";

            // Obtém lista de IDs internos (se houver)
            let idsInternos = [];
            if (prod.ids_vinculados && Array.isArray(prod.ids_vinculados)) {
                idsInternos = prod.ids_vinculados.map(id => String(id).trim()).filter(id => id);
            }

            // Caso não tenha ID interno, usa o EAN como fallback
            if (idsInternos.length === 0) {
                // Busca por EAN (já tentamos, mas mantemos)
                for (const hostConfig of hosts) {
                    for (const campo of ['alternateIds_Ean', 'ean']) {
                        const url = `${hostConfig.host}/api/catalog_system/pub/products/search?fq=${campo}:${prod.ean}&sc=${sc}&_=${Date.now()}`;
                        const result = await request(url);
                        if (result.status === 200 && result.data && result.data.length > 0) {
                            dados = result.data;
                            linkCompra = dados[0].link;
                            metodoUsado = `EAN (${campo}) em ${hostConfig.host}`;
                            break;
                        }
                    }
                    if (dados) break;
                }
            } else {
                // Tenta cada ID interno
                for (const id of idsInternos) {
                    for (const hostConfig of hosts) {
                        // Tenta cada campo de busca
                        for (const campo of camposBusca) {
                            let url = `${hostConfig.host}/api/catalog_system/pub/products/search?fq=${campo}:${id}&sc=${sc}&_=${Date.now()}`;
                            if (hostConfig.regionId) url += `&regionId=${hostConfig.regionId}`;
                            const result = await request(url);
                            if (result.status === 200 && result.data && result.data.length > 0) {
                                dados = result.data;
                                linkCompra = dados[0].link;
                                metodoUsado = `ID (${campo}) em ${hostConfig.host}`;
                                break;
                            }
                        }
                        if (dados) break;
                    }
                    if (dados) break;
                }

                // Se ainda não achou, tenta buscar pela página HTML (scraping)
                if (!dados) {
                    for (const id of idsInternos) {
                        for (const hostConfig of hosts) {
                            const urlHtml = `${hostConfig.host}/busca/${id}`;
                            const result = await request(urlHtml, { headers: { 'Accept': 'text/html' } });
                            if (result.status === 200 && typeof result.data === 'string') {
                                const preco = extrairPrecoDoHTML(result.data);
                                if (preco !== null) {
                                    // Monta um objeto simulado para usar no fluxo
                                    dados = [{
                                        link: urlHtml,
                                        items: [{
                                            sellers: [{
                                                commertialOffer: { Price: preco },
                                                sellerName: "Carrefour (HTML)"
                                            }]
                                        }]
                                    }];
                                    linkCompra = urlHtml;
                                    metodoUsado = `Scraping HTML em ${hostConfig.host}`;
                                    break;
                                }
                            }
                        }
                        if (dados) break;
                    }
                }
            }

            let resultado = null;

            if (dados && dados.length > 0) {
                const item = dados[0];
                let precoAtual = 0;

                // Tenta extrair preço do JSON da API
                if (item.items && item.items.length > 0) {
                    for (const seller of item.items[0].sellers) {
                        if (seller.commertialOffer && seller.commertialOffer.Price > 0) {
                            precoAtual = seller.commertialOffer.Price;
                            origem = seller.sellerName || "N/A";
                            break;
                        }
                    }
                }

                // Se o preço ainda for 0, tenta usar o preço extraído (caso scraping)
                if (precoAtual === 0 && item.preco) {
                    precoAtual = item.preco;
                }

                resultado = {
                    produto: prod.nome_comum,
                    loja: "Carrefour",
                    origem: origem,
                    link: linkCompra,
                    status: precoAtual > 0 ? "ENCONTRADO" : "SEM ESTOQUE (Preço 0,00)",
                    preco: precoAtual,
                    precoReferencia,
                    ultimoPrecoWeb,
                    temAlvo,
                    metodoUsado // útil para depuração
                };
            } else {
                resultado = {
                    produto: prod.nome_comum,
                    loja: "Carrefour",
                    origem: "N/A",
                    status: "NÃO ENCONTRADO",
                    preco: 0,
                    metodoUsado: "Nenhum método funcionou"
                };
            }

            relatorio.push({
                produto: resultado.produto,
                loja: resultado.loja,
                origem: resultado.origem,
                status: resultado.status,
                ...(resultado.preco > 0 && { preco: resultado.preco, referencia_usada: resultado.precoReferencia }),
                metodo: resultado.metodoUsado // opcional, pode ser removido depois
            });

            if (resultado.status === "ENCONTRADO" && resultado.preco > 0) {
                if (resultado.temAlvo && resultado.preco < resultado.precoReferencia) {
                    const jaExiste = await alertasCol.findOne({
                        produto_nome: resultado.produto,
                        loja: resultado.loja,
                        preco_atual: resultado.preco,
                        status_notificacao: "pendente"
                    });
                    if (!jaExiste) {
                        await alertasCol.insertOne({
                            produto_nome: resultado.produto,
                            loja: resultado.loja,
                            preco_historico: resultado.precoReferencia,
                            preco_atual: resultado.preco,
                            link_compra: resultado.link,
                            data_alerta: new Date(),
                            status_notificacao: "pendente"
                        });
                    }
                }
                if (resultado.preco !== resultado.ultimoPrecoWeb) {
                    await db.collection('historico_precos_web').insertOne({
                        nome: resultado.produto,
                        ean: prod.ean,
                        loja: resultado.loja,
                        origem: resultado.origem,
                        preco: resultado.preco,
                        data_verificacao: new Date()
                    });
                }
            }
        }

        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: relatorio
        };

    } catch (e) {
        context.res = {
            status: 500,
            headers: { "Content-Type": "application/json" },
            body: { erro: "Erro Crítico: " + e.message }
        };
    } finally {
        if (client) await client.close();
    }
};