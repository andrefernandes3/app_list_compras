const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const metodo = req.method;
    try {
        await client.connect();
        const db = client.db('app_compras');
        const colecao = db.collection('dicionario_produtos');

        if (metodo === 'GET') {
            // Retorna todo o seu dicionário organizado
            const produtos = await colecao.find({}).sort({ categoria: 1, nome_comum: 1 }).toArray();
            context.res = { status: 200, body: produtos };
        } 
        else if (metodo === 'POST') {
            const { idPrincipal, nomePadrao, categoria } = req.body;
            await colecao.updateOne(
                { nome_comum: nomePadrao.toUpperCase() },
                { 
                    $addToSet: { ids_vinculados: idPrincipal },
                    $set: { 
                        categoria: (categoria || "OUTROS").toUpperCase(),
                        ultima_atualizacao: new Date() 
                    }
                },
                { upsert: true }
            );
            context.res = { status: 200, body: "Dicionário atualizado!" };
        }
    } catch (e) {
        context.res = { status: 500, body: e.message };
    }
};