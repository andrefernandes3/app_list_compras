const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const { idPrincipal, nomePadrao, categoria } = req.body; // categoria pode vir ou não

    if (!idPrincipal || !nomePadrao) {
        context.res = { status: 400, body: "Dados incompletos para vínculo." };
        return;
    }

    try {
        await client.connect();
        const db = client.db('app_compras');
        const colecao = db.collection('dicionario_produtos');

        // Objeto com os campos que sempre serão atualizados
        const updateFields = {
            ultima_atualizacao: new Date()
        };

        // Se a categoria foi enviada, adiciona ao update
        if (categoria) {
            updateFields.categoria = categoria;
        } else {
            // Opcional: se quiser um valor padrão quando não enviado, descomente a linha abaixo
            // updateFields.categoria = "OUTROS";
        }

        await colecao.updateOne(
            { nome_comum: nomePadrao.toUpperCase() },
            {
                $addToSet: { ids_vinculados: idPrincipal },
                $set: updateFields
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