const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const nomeComum = req.query.nome; // Agora buscamos pelo Nome do Dicionário

    if (!nomeComum) {
        context.res = { status: 400, body: "Nome do produto necessário." };
        return;
    }

    try {
        await client.connect();
        const db = client.db('app_compras');
        
        // 1. Pega os IDs vinculados a este nome no dicionário
        const vinculo = await db.collection('dicionario_produtos').findOne({ 
            nome_comum: nomeComum.toUpperCase() 
        });
        
        if (!vinculo) {
            context.res = { status: 404, body: "Produto não catalogado." };
            return;
        }

        // 2. Busca o histórico de todos esses IDs para montar o gráfico
        const historico = await db.collection('historico_precos').aggregate([
            { $unwind: "$itens" },
            { $match: { "itens.id_interno": { $in: vinculo.ids_vinculados } } },
            { $sort: { "data_compra": 1 } }, // Ordem cronológica para o gráfico
            { $project: { 
                mercado: "$estabelecimento", 
                data: "$data_compra", 
                preco: "$itens.preco_unitario" 
            }}
        ]).toArray();

        context.res = { status: 200, body: historico };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};