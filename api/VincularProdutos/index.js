const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const metodo = req.method;

    try {
        await client.connect();

        const db = client.db('app_compras');
        const colecao = db.collection('dicionario_produtos');

        if (metodo === 'GET') {

            // Retorna o dicionário organizado por categoria e nome
            const produtos = await colecao
                .find({})
                .sort({ categoria: 1, nome_comum: 1 })
                .toArray();

            context.res = {
                status: 200,
                body: produtos
            };
        }

        else if (metodo === 'PATCH') {

            const { item, monitorar } = req.body;

            if (!item) {
                context.res = {
                    status: 400,
                    body: {
                        erro: "Nome do item é obrigatório."
                    }
                };
                return;
            }

            const resultado = await colecao.updateOne(
                {
                    nome_comum: item.trim().toUpperCase()
                },
                {
                    $set: {
                        monitorar: monitorar === true
                    }
                }
            );

            context.res = {
                status: 200,
                body: {
                    sucesso: true,
                    modificado: resultado.modifiedCount
                }
            };
        }

        else if (metodo === 'POST') {

            const { idPrincipal, nomePadrao, categoria, fotoUrl } = req.body;

            // Normalização rigorosa para evitar duplicatas por espaços ou caixa
            const nomeFormatado = nomePadrao.trim().toUpperCase();

            // Busca se o produto já existe para decidir sobre a foto
            const produtoExistente = await colecao.findOne({
                nome_comum: nomeFormatado
            });

            let updateQuery;

            if (produtoExistente) {

                updateQuery = {
                    $addToSet: {
                        ids_vinculados: idPrincipal
                    },
                    $set: {
                        categoria: (
                            categoria ||
                            produtoExistente.categoria ||
                            "OUTROS"
                        ).toUpperCase(),
                        ultima_atualizacao: new Date()
                    }
                };

                // Só sobrescreve a foto se vier uma nova URL
                if (fotoUrl && fotoUrl.trim() !== "") {
                    updateQuery.$set.foto_url = fotoUrl;
                }

            } else {

                updateQuery = {
                    $set: {
                        nome_comum: nomeFormatado,
                        ids_vinculados: [idPrincipal],
                        categoria: (categoria || "OUTROS").toUpperCase(),
                        foto_url: fotoUrl || "",
                        ultima_atualizacao: new Date()
                    }
                };
            }

            await colecao.updateOne(
                { nome_comum: nomeFormatado },
                updateQuery,
                { upsert: true }
            );

            context.res = {
                status: 200,
                body: "Vínculo e dicionário atualizados com sucesso!"
            };
        }

        else {
            context.res = {
                status: 405,
                body: "Método não permitido."
            };
        }

    } catch (e) {
        context.res = {
            status: 500,
            body: e.message
        };
    }
};