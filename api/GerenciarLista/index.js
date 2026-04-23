const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const metodo = req.method;
    await client.connect();
    const db = client.db('app_compras');
    const colecao = db.collection('lista_compras');

    try {
        // No ficheiro api/GerenciarLista/index.js, altere a linha do GET:
        if (metodo === 'GET') {
            // Agora buscamos todos os itens da lista para manter o Caminho B
            const lista = await colecao.find({}).toArray();
            context.res = { status: 200, body: lista };
        }
        else if (metodo === 'POST') {
            const { nome, quantidade } = req.body;
            await colecao.updateOne(
                { item_nome: nome.toUpperCase() },
                {
                    $set: {
                        comprado: false,
                        quantidade: parseFloat(quantidade) || 1, // Salva a quantidade
                        data_adicao: new Date()
                    }
                },
                { upsert: true }
            );
            context.res = { status: 201, body: "Item na lista!" };
        }        
        else if (metodo === 'PATCH') {
            const { nome, comprado, preco_real } = req.body;
            const updateData = {};

            if (comprado !== undefined) updateData.comprado = comprado;
            if (preco_real !== undefined) updateData.preco_real = parseFloat(preco_real);

            await colecao.updateOne(
                { item_nome: nome.toUpperCase() },
                { $set: updateData }
            );
            context.res = { status: 200, body: "Atualizado!" };
        }
    } catch (e) {
        context.res = { status: 500, body: e.message };
    }
};