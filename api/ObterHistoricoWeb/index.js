const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    try {
        await client.connect(); // AQUI É ONDE ELE CONECTA NO MONGO
        const db = client.db('app_compras');

        // Dentro da sua ObterHistoricoWeb/index.js
        const dados = await db.collection('historico_precos_web')
            .find({})
            .project({ nome: 1, loja: 1, preco: 1, data_verificacao: 1, _id: 0 }) // Traz só o necessário
            .sort({ data_verificacao: -1 }) // Traz os mais recentes primeiro
            .toArray();
        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: dados
        };
    } catch (e) {
        context.res = { status: 500, body: e.message };
    } finally {
        await client.close();
    }
};