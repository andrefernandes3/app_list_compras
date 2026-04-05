const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const metodo = req.method;

    try {
        await client.connect();
        const db = client.db('app_compras');
        const colecao = db.collection('lista_compras');

        if (metodo === 'GET') {
            const lista = await colecao.find({ comprado: false }).toArray();
            context.res = { status: 200, body: lista };
        } 
        else if (metodo === 'POST') {
            const { nome } = req.body;
            await colecao.updateOne(
                { item_nome: nome.toUpperCase() },
                { $set: { comprado: false, data_adicao: new Date() } },
                { upsert: true }
            );
            context.res = { status: 201, body: "Item adicionado!" };
        }
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};