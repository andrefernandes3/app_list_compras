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
            const itens = await col.find({}).sort({ nome_comum: 1 }).toArray();
            context.res = { status: 200, body: itens };
        } 
        else if (metodo === 'PUT') {
            // TRAVA 1: Garante que o body seja lido como JSON, independente de como o Azure mandou
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

            // Tratamento: Desmarcar Todos
            if (body && body.action === 'desmarcar_todos') {
                await col.updateMany({}, { $set: { monitorar: false } });
                context.res = { status: 200, body: { message: "Todos os itens desmarcados no BD." } };
            } 
            else {
                // Tratamento: Salvar 1 item
                const { id, monitorar, preco_alvo } = body;
                
                // TRAVA 2: Força o monitorar a ser um Booleano absoluto (true ou false)
                let updateFields = { 
                    monitorar: (monitorar === true || monitorar === "true") 
                };
                
                // TRAVA 3: Converte o preço com segurança para não quebrar no banco
                if (preco_alvo !== undefined) {
                    updateFields.preco_alvo = preco_alvo ? parseFloat(String(preco_alvo).replace(',', '.')) : null;
                }
                
                await col.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updateFields }
                );
                context.res = { status: 200, body: { message: "Item atualizado no BD com sucesso." } };
            }
        }
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    }
};