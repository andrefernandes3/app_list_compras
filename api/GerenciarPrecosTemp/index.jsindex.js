const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);
let dbPromise = null;

async function getDb() {
    if (!dbPromise) {
        dbPromise = client.connect().then(() => client.db('app_compras'));
    }
    return dbPromise;
}

module.exports = async function (context, req) {
    const db = await getDb();
    const colecao = db.collection('carrinho_temp');

    try {
        if (req.method === 'GET') {
            const dados = await colecao.find({}).toArray();
            context.res = { status: 200, body: dados };
        } 
       else if (req.method === 'POST') {
    const { item, loja, preco } = req.body;
    
    // Mudança: agora aceita o preço se ele for exatamente 0
    if (!item || !loja || isNaN(parseFloat(preco)) || parseFloat(preco) < 0) {
        context.res = { status: 400, body: "Dados inválidos para persistência." };
        return;
    }

    await colecao.updateOne(
        { item: item.toUpperCase(), loja: loja.toUpperCase() },
        { $set: { preco: parseFloat(preco), atualizado_em: new Date() } },
        { upsert: true }
    );
    
    context.res = { status: 200, body: "Preço persistido com sucesso!" };
}
        else if (req.method === 'DELETE') {
            await colecao.deleteMany({});
            context.res = { status: 200, body: "Sessão de preços limpa!" };
        }
    } catch (e) {
        context.res = { status: 500, body: e.message };
    }
};
