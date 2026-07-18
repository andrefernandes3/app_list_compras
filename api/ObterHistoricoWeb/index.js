const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    try {
        await client.connect(); // AQUI É ONDE ELE CONECTA NO MONGO
        const db = client.db('app_compras');
        
        // Aqui ele busca na coleção do robô
        const dados = await db.collection('historico_precos_web').find({}).toArray();

        context.res = { 
            status: 200, 
            body: dados 
        };
    } catch (e) {
        context.res = { status: 500, body: e.message };
    } finally {
        await client.close();
    }
};