const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    try {
        await client.connect();
        const db = client.db('app_compras');

        // Busca apenas os documentos que tenham nome, loja e preco
        // Usamos .project para reduzir o tráfego de rede
        const historico = await db.collection('historico_precos_web')
            .find({ preco: { $gt: 0 } })
            .project({ nome: 1, loja: 1, preco: 1, _id: 0 })
            .sort({ data_verificacao: -1 })
            .toArray();

        context.res = { 
            status: 200, 
            headers: { "Content-Type": "application/json" },
            body: historico 
        };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    } finally {
        await client.close();
    }
};