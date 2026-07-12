const https = require('https');
const { MongoClient } = require('mongodb');

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
        host: 'https://mercado.carrefour.com.br', // subdomínio correto
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

        // Busca produtos ativos (monitorar = true)
        const monitorados = await dicionarioCol.find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();

        if (monitorados.length === 0) {
            context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        for (const prod of monitorados) {
            const ultimoPrecoWeb = await obterUltimoPrecoValido(db, prod.nome_comum, lojaConfig.nome);
            const precoReferencia = prod.preco_alvo || ultimoPrecoWeb;
            const temAlvo = precoReferencia !== Infinity;

            let dados = null;

            // 1. Tenta buscar usando o primeiro ID de ids_vinculados (se existir)
            if (prod.ids_vinculados && prod.ids_vinculados.length > 0) {
                const idInterno = prod.ids_vinculados[0];
                let urlId = `${lojaConfig.host}/api/catalog_system/pub/products/search?fq=productId:${idInterno}&sc=${lojaConfig.sc}&_=${Date.now()}`;
                dados = await buscarDadosVtex(urlId);
                // Se não houver logs disponíveis, pode ignorar
            }

            // 2. Se não achou, tenta por EAN
            if (!dados || dados.length === 0) {
                let urlEan = `${lojaConfig.host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${prod.ean}&sc=${lojaConfig.sc}&_=${Date.now()}`;
                dados = await buscarDadosVtex(urlEan);
            }

            // 3. Último recurso: busca por nome do produto
            if (!dados || dados.length === 0) {
                const nomeCodificado = encodeURIComponent(prod.nome_comum);
                let urlNome = `${lojaConfig.host}/api/catalog_system/pub/products/search?q=${nomeCodificado}&sc=${lojaConfig.sc}&_=${Date.now()}`;
                dados = await buscarDadosVtex(urlNome);
            }

            let resultado = null;

            if (dados && dados.length > 0) {
                const item = dados[0];
                let precoAtual = 0;
                let linkCompra = item.link;
                let nomeLojaOrigem = "N/A";

                if (item.items && item.items.length > 0) {
                    for (const seller of item.items[0].sellers) {
                        if (seller.commertialOffer && seller.commertialOffer.Price > 0) {
                            precoAtual = seller.commertialOffer.Price;
                            nomeLojaOrigem = seller.sellerName || "N/A";
                            break;
                        }
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
                    preco: 0
                };
            }

            // Monta relatório
            relatorio.push({
                produto: resultado.produto,
                loja: resultado.loja,
                origem: resultado.origem,
                status: resultado.status,
                ...(resultado.preco > 0 && { preco: resultado.preco, referencia_usada: resultado.precoReferencia })
            });

            // Processa alertas e histórico (se encontrado)
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