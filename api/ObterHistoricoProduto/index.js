const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const nomeProduto = req.query.nome;
    const dias = parseInt(req.query.dias) || 0;

    try {
        await client.connect();
        const db = client.db('app_compras');

        // 1. Localiza o produto no dicionário para pegar os IDs vinculados
        const produto = await db.collection('dicionario_produtos').findOne({ 
            nome_comum: nomeProduto.toUpperCase() 
        });

        if (!produto) {
            context.res = { status: 404, body: [] };
            return;
        }

        // 2. Define o filtro de data se o parâmetro 'dias' for enviado
        let matchStage = { "itens.id_interno": { $in: produto.ids_vinculados } };
        if (dias > 0) {
            const dataLimite = new Date();
            dataLimite.setDate(dataLimite.getDate() - dias);
            matchStage["data_compra"] = { $gte: dataLimite };
        }

        // 3. Busca o histórico formatado
        const historico = await db.collection('historico_precos').aggregate([
            { $unwind: "$itens" },
            { $match: matchStage },
            { $sort: { data_compra: 1 } },
            {
                $project: {
                    _id: 0,
                    data: "$data_compra",
                    preco: "$itens.preco_unitario",
                    mercado: "$estabelecimento"
                }
            }
        ]).toArray();

        context.res = { status: 200, body: historico };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};
