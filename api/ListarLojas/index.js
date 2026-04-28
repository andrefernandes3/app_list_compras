const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    try {
        await client.connect();
        const db = client.db('app_compras');
        
        // Busca todos os nomes únicos do campo estabelecimento
        const lojas = await db.collection('historico_precos').distinct("estabelecimento");
        
        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: lojas.sort() // Já envia em ordem alfabética
        };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};
