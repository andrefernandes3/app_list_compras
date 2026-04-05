const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const metodo = req.method;
    await client.connect();
    const db = client.db('app_compras');
    const colecao = db.collection('lista_compras');

    try {
        if (metodo === 'GET') {
            // Busca apenas itens ativos (não comprados)
            const lista = await colecao.find({ comprado: false }).toArray();
            context.res = { status: 200, body: lista };
        } 
        else if (metodo === 'POST') {
            const { nome } = req.body;
            // Upsert: Se já existir, volta para a lista (comprado: false)
            await colecao.updateOne(
                { item_nome: nome.toUpperCase() },
                { $set: { comprado: false, data_adicao: new Date() } },
                { upsert: true }
            );
            context.res = { status: 201, body: "Item na lista!" };
        }
        else if (metodo === 'PATCH') {
            const { nome, comprado } = req.body;
            // Salva o status real no banco de dados
            await colecao.updateOne(
                { item_nome: nome.toUpperCase() },
                { $set: { comprado: comprado } }
            );
            context.res = { status: 200, body: "Status atualizado!" };
        }
    } catch (e) {
        context.res = { status: 500, body: e.message };
    }
};