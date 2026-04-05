const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const { idPrincipal, nomePadrao } = req.body;

    if (!idPrincipal || !nomePadrao) {
        context.res = { status: 400, body: "Dados incompletos para vínculo." };
        return;
    }

    try {
        await client.connect();
        const db = client.db('app_compras');
        const colecao = db.collection('dicionario_produtos');

        // $addToSet garante que o ID entra no array mas não se repete
        await colecao.updateOne(
            { nome_comum: nomePadrao.toUpperCase() },
            {
                $addToSet: { ids_vinculados: idPrincipal },
                $set: { ultima_atualizacao: new Date() }
            },
            { upsert: true }
        );

        context.res = {
            status: 200,
            body: { message: "Vínculo guardado com sucesso!" }
        };
    } catch (error) {
        context.log("Erro ao vincular:", error.message);
        context.res = { status: 500, body: error.message };
    }
};