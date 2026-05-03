const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    try {
        await client.connect();
        const db = client.db('app_compras');

        // 1. Agregação pesada: Cruza o histórico com o dicionário pelo ID Interno
        const ranking = await db.collection('historico_precos').aggregate([
            { $unwind: "$itens" },
            {
                $lookup: {
                    from: "dicionario_produtos",
                    localField: "itens.id_interno",
                    foreignField: "ids_vinculados",
                    as: "produto_info"
                }
            },
            { $unwind: "$produto_info" },
            {
                $group: {
                    _id: "$produto_info.nome_comum",
                    foto: { $first: "$produto_info.foto_url" },
                    totalQtd: { $sum: "$itens.quantidade" },
                    vezesComprado: { $sum: 1 },
                    totalGasto: { $sum: { $multiply: ["$itens.quantidade", "$itens.preco_unitario"] } }
                }
            },
            { $sort: { totalQtd: -1 } },
            { $limit: 10 }
        ]).toArray();

        context.res = { status: 200, body: ranking };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};