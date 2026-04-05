const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const nomeComum = req.query.nome; // Ex: PAO FORMA INTEGRAL PANCO 500G

    if (!nomeComum) {
        context.res = { status: 400, body: "Nome do produto não fornecido." };
        return;
    }

    try {
        await client.connect();
        const db = client.db('app_compras');
        
        // 1. Busca os IDs vinculados a esse nome no seu dicionário
        const vinculo = await db.collection('dicionario_produtos').findOne({ 
            nome_comum: nomeComum.toUpperCase() 
        });
        
        if (!vinculo) {
            context.res = { status: 404, body: "Produto ainda não catalogado no dicionário." };
            return;
        }

        // 2. Busca o histórico e agrupa pelo menor preço de cada mercado
        const comparativo = await db.collection('historico_precos').aggregate([
            { $unwind: "$itens" },
            { $match: { "itens.id_interno": { $in: vinculo.ids_vinculados } } },
            { $group: {
                _id: "$estabelecimento",
                menorPreco: { $min: "$itens.preco_unitario" },
                ultimaCompra: { $max: "$data_compra" }
            }},
            { $sort: { menorPreco: 1 } } // O mais barato primeiro
        ]).toArray();

        context.res = { 
            status: 200, 
            headers: { "Content-Type": "application/json" },
            body: comparativo 
        };
    } catch (error) {
        context.log("Erro na comparação:", error.message);
        context.res = { status: 500, body: error.message };
    }
};