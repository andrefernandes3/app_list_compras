const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const idInterno = req.query.id; // Ex: /api/ObterHistoricoProduto?id=789...

    if (!idInterno) {
        context.res = { status: 400, body: "ID do produto necessário." };
        return;
    }

    try {
        await client.connect();
        const db = client.db('app_compras');
        const colecao = db.collection('historico_precos');

        // Busca todas as notas que contêm esse produto
        const historico = await colecao.aggregate([
            { $unwind: "$itens" },
            { $match: { "itens.id_interno": idInterno } },
            { $sort: { "data_compra": -1 } },
            { $project: { 
                estabelecimento: 1, 
                data_compra: 1, 
                preco: "$itens.preco_unitario" 
            }}
        ]).toArray();

        context.res = { status: 200, body: historico };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};