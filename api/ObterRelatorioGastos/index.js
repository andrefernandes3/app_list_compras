const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    try {
        await client.connect();
        const db = client.db('app_compras');

        const relatorio = await db.collection('historico_precos').aggregate([
            { $unwind: "$itens" },
            // Cruzamento inteligente: busca a categoria no dicionário pelo ID
            {
                $lookup: {
                    from: "dicionario_produtos",
                    localField: "itens.id_interno",
                    foreignField: "ids_vinculados",
                    as: "vinculo"
                }
            },
            // Define a categoria: se achou no dicionário usa ela, senão usa "OUTROS"
            {
                $addFields: {
                    categoria_final: {
                        $ifNull: [{ $arrayElemAt: ["$vinculo.categoria", 0] }, "OUTROS"]
                    }
                }
            },
            {
               // ... dentro do aggregate
                $group: {
                    _id: "$categoria_final",
                    totalGasto: { $sum: "$itens.preco_total" },
                    detalhes: {
                        $push: {
                            nome: "$itens.descricao",
                            valor: "$itens.preco_total",
                            qtd: "$itens.quantidade"
                        }
                    }
                }
            },
            // ... ordena por gasto total decrescente
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