// No seu backend de relatórios:
const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const filtroLoja = req.query.loja; // Pega a loja da URL, ex: ?loja=CARREFOUR%20CENTRO

    try {
        await client.connect();
        const db = client.db('app_compras');

        const matchStage = filtroLoja ? { "estabelecimento": filtroLoja } : {};

        const relatorio = await db.collection('historico_precos').aggregate([
            { $match: filtroLoja ? { "estabelecimento": filtroLoja } : {} }, 
    { $unwind: "$itens" },
            {
                $lookup: {
                    from: "dicionario_produtos",
                    localField: "itens.id_interno",
                    foreignField: "ids_vinculados",
                    as: "vinculo"
                }
            },
            {
                $addFields: {
                    categoria_final: {
                        $ifNull: [{ $arrayElemAt: ["$vinculo.categoria", 0] }, "OUTROS"]
                    }
                }
            },
            {
                $group: {
                    _id: "$categoria_final",
                    totalGasto: { $sum: "$itens.preco_total" },
                    detalhes: {
                        $push: {
                            nome: "$itens.descricao",
                            valor: "$itens.preco_total",
                            qtd: "$itens.quantidade",
                            loja: "$estabelecimento" // Adicionamos a loja nos detalhes
                        }
                    }
                }
            },
            { $sort: { totalGasto: -1 } }
        ]).toArray();

        context.res = { status: 200, body: relatorio };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};
