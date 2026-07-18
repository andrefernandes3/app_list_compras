const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    try {
        await client.connect();
        const db = client.db('app_compras');

        // BUSCAMOS NA COLEÇÃO CORRETA: historico_precos_web
        // Se não vier nome, trazemos tudo (limitado para performance)
        const query = req.query.nome ? { nome: req.query.nome.toUpperCase() } : {};
        
        const historico = await db.collection('historico_precos_web')
            .find(query)
            .sort({ data_verificacao: -1 }) // Mais recentes primeiro
            .limit(2000) 
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