const https = require('https');
const { MongoClient } = require('mongodb');

// Função para obter preço via scraping da página HTML
async function obterPrecoPorScraping(urlProduto) {
    return new Promise((resolve) => {
        const urlObj = new URL(urlProduto);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        };

        const req = https.request(options, (res) => {
            let html = '';
            res.on('data', chunk => html += chunk);
            res.on('end', () => {
                // Tenta encontrar preço em JSON-LD
                const regex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
                let match;
                while ((match = regex.exec(html)) !== null) {
                    try {
                        const json = JSON.parse(match[1]);
                        // Busca por offers.price ou price
                        if (json.offers && json.offers.price) {
                            return resolve(parseFloat(json.offers.price));
                        }
                        if (json.price) {
                            return resolve(parseFloat(json.price));
                        }
                    } catch (e) {}
                }
                // Tenta encontrar preço em atributos data
                const priceRegex = /"price":"([\d,.]+)"/g;
                const priceMatch = priceRegex.exec(html);
                if (priceMatch) {
                    const priceStr = priceMatch[1].replace(',', '.');
                    return resolve(parseFloat(priceStr));
                }
                resolve(null);
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

async function obterUltimoPrecoValido(db, nomeProduto, nomeLoja) {
    const ultimoRegistro = await db.collection('historico_precos_web')
        .find({ nome: nomeProduto, loja: nomeLoja, preco: { $gt: 0 } })
        .sort({ data_verificacao: -1 })
        .limit(1)
        .toArray();
    return ultimoRegistro.length === 0 ? Infinity : ultimoRegistro[0].preco;
}

const buscarDadosVtex = (targetUrl) => {
    return new Promise((resolve) => {
        const urlObj = new URL(targetUrl);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        };

        const reqHttp = https.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let novaUrl = res.headers.location;
                if (novaUrl.startsWith('/')) novaUrl = `https://${urlObj.hostname}${novaUrl}`;
                return resolve(buscarDadosVtex(novaUrl));
            }
            if (res.statusCode !== 200) return resolve(null);

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve(null); }
            });
        });

        reqHttp.on('error', () => resolve(null));
        reqHttp.end();
    });
};

module.exports = async function (context, req) {
    const lojaConfig = {
        id: 'CARREFOUR',
        nome: "Carrefour",
        host: 'https://mercado.carrefour.com.br',
        regionId: '',
        sc: '1'
    };

    let client = null;
    let relatorio = [];

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        const dicionarioCol = db.collection('dicionario_produtos');
        const alertasCol = db.collection('alertas_preco');

        const monitorados = await dicionarioCol.find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();

        if (monitorados.length === 0) {
            context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        for (const prod of monitorados) {
            const ultimoPrecoWeb = await obterUltimoPrecoValido(db, prod.nome_comum, lojaConfig.nome);
            const precoReferencia = prod.preco_alvo || ultimoPrecoWeb;
            const temAlvo = precoReferencia !== Infinity;

            let precoEncontrado = 0;
            let linkCompra = null;
            let nomeLojaOrigem = "N/A";
            let status = "NÃO ENCONTRADO";
            let dados = null;

            // 1. Tenta buscar via API usando IDs_vinculados
            if (prod.ids_vinculados && prod.ids_vinculados.length > 0) {
                const idInterno = prod.ids_vinculados[0];
                // Tenta diferentes formatos de endpoint
                const endpoints = [
                    `${lojaConfig.host}/api/catalog_system/pub/products/search?fq=productId:${idInterno}&sc=${lojaConfig.sc}`,
                    `${lojaConfig.host}/api/catalog_system/pub/products/productid/${idInterno}?sc=${lojaConfig.sc}`,
                    `${lojaConfig.host}/api/catalog_system/pub/products/variations?productId=${idInterno}&sc=${lojaConfig.sc}`
                ];
                for (const url of endpoints) {
                    dados = await buscarDadosVtex(url);
                    if (dados && (dados.length > 0 || dados.id)) break;
                }
            }

            // 2. Se não achou, tenta por EAN
            if (!dados || (Array.isArray(dados) && dados.length === 0)) {
                let urlEan = `${lojaConfig.host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${prod.ean}&sc=${lojaConfig.sc}`;
                dados = await buscarDadosVtex(urlEan);
            }

            // 3. Se ainda não, tenta scraping da página HTML usando o primeiro ID
            if ((!dados || (Array.isArray(dados) && dados.length === 0)) && prod.ids_vinculados && prod.ids_vinculados.length > 0) {
                const idInterno = prod.ids_vinculados[0];
                const urlPagina = `${lojaConfig.host}/busca/${idInterno}`;
                const precoScraping = await obterPrecoPorScraping(urlPagina);
                if (precoScraping !== null && precoScraping > 0) {
                    precoEncontrado = precoScraping;
                    linkCompra = urlPagina;
                    nomeLojaOrigem = "Carrefour (scraping)";
                    status = "ENCONTRADO";
                }
            }

            // Se dados via API, extrai preço
            if (dados) {
                let item = Array.isArray(dados) ? dados[0] : dados;
                if (item) {
                    if (item.items && item.items.length > 0) {
                        for (const seller of item.items[0].sellers) {
                            if (seller.commertialOffer && seller.commertialOffer.Price > 0) {
                                precoEncontrado = seller.commertialOffer.Price;
                                nomeLojaOrigem = seller.sellerName || "N/A";
                                break;
                            }
                        }
                    } else if (item.price) {
                        // Caso o endpoint retorne price diretamente
                        precoEncontrado = item.price;
                    }
                    linkCompra = item.link || linkCompra;
                    if (precoEncontrado > 0) status = "ENCONTRADO";
                }
            }

            // Se ainda não encontrou preço, status permanece NÃO ENCONTRADO
            if (precoEncontrado === 0) {
                status = "NÃO ENCONTRADO";
            } else if (precoEncontrado === 0 && status !== "ENCONTRADO") {
                status = "NÃO ENCONTRADO";
            } else {
                status = "ENCONTRADO";
            }

            // Monta resultado
            const resultado = {
                produto: prod.nome_comum,
                loja: lojaConfig.nome,
                origem: nomeLojaOrigem,
                link: linkCompra,
                status: status,
                preco: precoEncontrado,
                precoReferencia,
                ultimoPrecoWeb,
                temAlvo
            };

            relatorio.push({
                produto: resultado.produto,
                loja: resultado.loja,
                origem: resultado.origem,
                status: resultado.status,
                ...(resultado.preco > 0 && { preco: resultado.preco, referencia_usada: resultado.precoReferencia })
            });

            // Processa alertas e histórico
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