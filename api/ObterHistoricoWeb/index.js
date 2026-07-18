const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    try {
        await client.connect();
        const db = client.db('app_compras');

        // Busca apenas os dados do Robô na coleção correta
        // O .project garante que só traremos o necessário para o preenchimento
        const dadosRobo = await db.collection('historico_precos_web')
            .find({})
            .project({ nome: 1, loja: 1, preco: 1, _id: 0 })
            .sort({ data_verificacao: -1 })
            .toArray();

        context.res = { 
            status: 200, 
            headers: { "Content-Type": "application/json" },
            body: dadosRobo 
        };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    } finally {
        await client.close();
    }
};