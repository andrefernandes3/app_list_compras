const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const metodo = req.method;

    try {
        await client.connect();
        const db = client.db('app_compras');
        const colecao = db.collection('dicionario_produtos');

        // BUSCAR TODOS (Para a nova aba de Dicionário)
        if (metodo === 'GET') {
            const produtos = await colecao.find({}).sort({ nome_comum: 1 }).toArray();
            context.res = { 
                status: 200, 
                headers: { "Content-Type": "application/json" },
                body: produtos 
            };
        } 
        // SALVAR OU ATUALIZAR VÍNCULO (Com Categoria)
        else if (metodo === 'POST') {
            const { idPrincipal, nomePadrao, categoria } = req.body;

            if (!nomePadrao || !idPrincipal) {
                context.res = { status: 400, body: "Dados insuficientes." };
                return;
            }

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

            context.res = { status: 200, body: { message: "Vínculo atualizado com sucesso!" } };
        }
    } catch (error) {
        context.log("Erro na API VincularProdutos:", error.message);
        context.res = { 
            status: 500, 
            body: "Erro interno: " + error.message 
        };
    }
};