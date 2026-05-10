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
            // Retorna o dicionário organizado por categoria e nome
            const produtos = await colecao.find({}).sort({ categoria: 1, nome_comum: 1 }).toArray();
            context.res = { status: 200, body: produtos };
        } 
        else if (metodo === 'POST') {
            const { idPrincipal, nomePadrao, categoria, fotoUrl } = req.body;
            
            // Normalização rigorosa para evitar duplicatas por espaços ou caixa
            const nomeFormatado = nomePadrao.trim().toUpperCase();

            // 1. Busca se o produto já existe para decidir sobre a foto
            const produtoExistente = await colecao.findOne({ nome_comum: nomeFormatado });

            let updateQuery;

            if (produtoExistente) {
                // SE JÁ EXISTE: 
                // - Adiciona o novo ID à lista sem duplicar ($addToSet)
                // - Atualiza categoria e data
                updateQuery = {
                    $addToSet: { ids_vinculados: idPrincipal },
                    $set: {
                        categoria: (categoria || produtoExistente.categoria || "OUTROS").toUpperCase(),
                        ultima_atualizacao: new Date()
                    }
                };

                // PROTEÇÃO DA FOTO: Só sobrescreve se o usuário enviou uma nova URL
                if (fotoUrl && fotoUrl.trim() !== "") {
                    updateQuery.$set.foto_url = fotoUrl;
                }
            } else {
                // SE É NOVO: 
                // Cria o documento com todos os campos básicos
                updateQuery = {
                    $set: {
                        nome_comum: nomeFormatado,
                        ids_vinculados: [idPrincipal],
                        categoria: (categoria || "OUTROS").toUpperCase(),
                        foto_url: fotoUrl || "", // Se for novo e vazio, inicia vazio
                        ultima_atualizacao: new Date()
                    }
                };
            }

            // Executa a atualização baseada no nome_comum
            // O upsert: true garante a criação caso o findOne falhe por milissegundos de diferença
            await colecao.updateOne(
                { nome_comum: nomeFormatado },
                updateQuery,
                { upsert: true }
            );

            context.res = { status: 200, body: "Vínculo e dicionário atualizados com sucesso!" };
        }
    } catch (e) {
        context.res = { status: 500, body: e.message };
    }
};