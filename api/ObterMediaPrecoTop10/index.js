const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    try {
        await client.connect();
        const db = client.db('app_compras');

        const medias = await db.collection('historico_precos').aggregate([
            { $unwind: "$itens" },
            {
                $lookup: {
                    from: "dicionario_produtos",
                    localField: "itens.id_interno",
                    foreignField: "ids_vinculados",
                    as: "prod"
                }
            },
            { $unwind: "$prod" },
            {
                $group: {
                    _id: "$prod.nome_comum",
                    precoMedio: { $avg: "$itens.preco_unitario" },
                    totalQtd: { $sum: "$itens.quantidade" }
                }
            },
            { $sort: { totalQtd: -1 } },
            { $limit: 10 }
        ]).toArray();

        context.res = { status: 200, body: medias };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};