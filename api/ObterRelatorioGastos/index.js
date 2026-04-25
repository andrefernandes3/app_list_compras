const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    try {
        await client.connect();
        const db = client.db('app_compras');
        
        // Agregação poderosa: Soma os gastos totais agrupando por categoria
        const relatorio = await db.collection('historico_precos').aggregate([
            { $unwind: "$itens" },
            { 
                $group: {
                    _id: "$itens.categoria", 
                    totalGasto: { $sum: "$itens.preco_total" }
                }
            },
            { $sort: { totalGasto: -1 } }
        ]).toArray();

        context.res = { 
            status: 200, 
            headers: { "Content-Type": "application/json" },
            body: relatorio 
        };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};