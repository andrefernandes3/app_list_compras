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
            // Retorna todo o seu dicionário organizado
            const produtos = await colecao.find({}).sort({ categoria: 1, nome_comum: 1 }).toArray();
            context.res = { status: 200, body: produtos };
        }
        else if (metodo === 'POST') {

            const { idPrincipal, nomePadrao, categoria, fotoUrl } = req.body;
            const nomeFormatado = nomePadrao.trim().toUpperCase();

            // 1. Busca o documento existente pelo nome comum
            const produtoExistente = await colecao.findOne({ nome_comum: nomeFormatado });

            let updateQuery;

            if (produtoExistente) {
                // SE JÁ EXISTE: Mantemos a foto antiga se a nova vier vazia
                updateQuery = {
                    $addToSet: { ids_vinculados: idPrincipal }, // Adiciona o novo ID sem duplicar
                    $set: {
                        categoria: (categoria || produtoExistente.categoria || "OUTROS").toUpperCase(),
                        ultima_atualizacao: new Date()
                    }
                };

                // Só atualiza a foto se você realmente enviou uma nova URL
                if (fotoUrl && fotoUrl.trim() !== "") {
                    updateQuery.$set.foto_url = fotoUrl;
                }
            } else {
                // SE É NOVO: Cria do zero com os dados enviados
                updateQuery = {
                    $setOnInsert: { nome_comum: nomeFormatado },
                    $addToSet: { ids_vinculados: idPrincipal },
                    $set: {
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

            context.res = { status: 200, body: "Vínculo atualizado com sucesso!" };
        }
    } catch (e) {
        context.res = { status: 500, body: e.message };
    }
};
