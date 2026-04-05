const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const { idPrincipal, idNovo, nomePadrao } = req.body;

    try {
        await client.connect();
        const db = client.db('app_compras');
        const colecao = db.collection('dicionario_produtos');

        // Atualiza ou cria o vínculo: adiciona o novo ID ao array sem duplicar
        await colecao.updateOne(
            { nome_comum: nomePadrao },
            { 
                $addToSet: { ids_vinculados: { $each: [idPrincipal, idNovo] } },
                $set: { ultima_atualizacao: new Date() }
            },
            { upsert: true }
        );

        context.res = { status: 200, body: "Vínculo criado com sucesso!" };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};