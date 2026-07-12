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
    const configs = [
        {
            id: 'CARREFOUR',
            nome: "Carrefour",
            host: 'https://www.carrefour.com.br',
            regionId: '',   // pode ser que precise de um valor; teste sem primeiro
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

        const monitorados = await dicionarioCol.find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();

        if (monitorados.length === 0) {
            context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { aviso: "Nenhum produto válido para monitorar." } };
            return;
        }

        for (const prod of monitorados) {
            const promessasBusca = configs.map(async (lojaConfig) => {
                try {
                    const ultimoPrecoWeb = await obterUltimoPrecoValido(db, prod.nome_comum, lojaConfig.nome);
                    const precoReferencia = prod.preco_alvo || ultimoPrecoWeb;
                    const temAlvo = precoReferencia !== Infinity;

                    // Função auxiliar para tentar diferentes campos de busca
                    const tentarBuscarPorCampo = async (campo) => {
                        let url = `${lojaConfig.host}/api/catalog_system/pub/products/search?fq=${campo}:${prod.ean}&sc=${lojaConfig.sc}&_=${Date.now()}`;
                        if (lojaConfig.regionId) url += `&regionId=${lojaConfig.regionId}`;
                        
                        context.log(`[DEBUG] Buscando no Carrefour com ${campo} -> ${url}`);
                        const data = await buscarDadosVtex(url);
                        if (data && data.length > 0) {
                            return data;
                        }
                        return null;
                    };

                    // Tenta primeiro alternateIds_Ean (padrão VTEX), depois ean (alternativa)
                    let data = await tentarBuscarPorCampo('alternateIds_Ean');
                    if (!data) {
                        context.log(`[DEBUG] alternateIds_Ean não retornou dados, tentando 'ean'`);
                        data = await tentarBuscarPorCampo('ean');
                    }

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

                        return {
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
                        context.log(`[DEBUG] Produto ${prod.nome_comum} não encontrado no Carrefour (ambos os campos)`);
                        return {
                            produto: prod.nome_comum,
                            loja: lojaConfig.nome,
                            origem: "N/A",
                            status: "NÃO ENCONTRADO",
                            preco: 0
                        };
                    }
                } catch (err) {
                    context.log(`[ERRO] Falha ao processar ${prod.nome_comum} no Carrefour: ${err.message}`);
                    return {
                        produto: prod.nome_comum,
                        loja: lojaConfig.nome,
                        origem: "ERRO",
                        status: "ERRO DE CONEXÃO",
                        preco: 0
                    };
                }
            });

            const resultadosDoProduto = await Promise.all(promessasBusca);

            for (const res of resultadosDoProduto) {
                relatorio.push({
                    produto: res.produto,
                    loja: res.loja,
                    origem: res.origem,
                    status: res.status,
                    ...(res.preco > 0 && { preco: res.preco, referencia_usada: res.precoReferencia })
                });

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
        context.res = {
            status: 500,
            headers: { "Content-Type": "application/json" },
            body: { erro: "Erro Crítico: " + e.message }
        };
    } finally {
        if (client) await client.close();
    }
};