const { MongoClient, ObjectId } = require('mongodb');

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
    const metodo = req.method;

    try {
        const db = await getDb();
        const col = db.collection('dicionario_produtos');

        if (metodo === 'GET') {
            // Retorna todos os produtos do dicionário
            const itens = await col.find({}).sort({ nome_comum: 1 }).toArray();
            context.res = { status: 200, body: itens };
        } 
        else if (metodo === 'PUT') {
            // Verifica se é o comando de "Desmarcar Todos"
            if (req.body && req.body.action === 'desmarcar_todos') {
                await col.updateMany({}, { $set: { monitorar: false } });
                context.res = { status: 200, body: "Todos os itens desmarcados." };
            } 
            else {
                // Atualiza um único item (Liga/Desliga o Sino e define Preço Alvo)
                const { id, monitorar, preco_alvo } = req.body;
                let updateFields = { monitorar };
                
                // Se o usuário digitou um preço, salva como número. Se apagou, salva como null
                if (preco_alvo !== undefined) {
                    updateFields.preco_alvo = preco_alvo ? parseFloat(preco_alvo.replace(',', '.')) : null;
                }
                
                await col.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updateFields }
                );
                context.res = { status: 200, body: "Atualizado com sucesso" };
            }
        }
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    }
};