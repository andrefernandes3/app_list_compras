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
                 
const { idPrincipal, nomePadrao, categoria, fotoUrl } = req.body; 

// 1. Montamos o objeto básico de atualização
const updateQuery = { 
    $addToSet: { ids_vinculados: idPrincipal },
    $set: { 
        categoria: (categoria || "OUTROS").toUpperCase(),
        ultima_atualizacao: new Date() 
    }
};

// 2. REGRA DE OURO: Só atualiza a foto se houver uma nova URL sendo enviada
// Isso evita que o campo fique vazio caso você salve o item sem foto
if (fotoUrl && fotoUrl.trim() !== "") {
    updateQuery.$set.foto_url = fotoUrl;
}

await colecao.updateOne(
    { nome_comum: nomePadrao.toUpperCase() },
    updateQuery,
    { upsert: true }
);

context.res = { status: 200, body: "Dicionário atualizado!" };
        }
    } catch (e) {
        context.res = { status: 500, body: e.message };
    }
};
