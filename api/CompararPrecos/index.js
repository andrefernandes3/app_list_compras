const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    try {
        await client.connect();
        const db = client.db('app_compras');

        // 1. Pega os itens da sua lista de compras (os que ainda não foram riscados)
        const listaAtiva = await db.collection('lista_compras').find({}).toArray();
        if (listaAtiva.length === 0) {
            context.res = { status: 200, body: [] };
            return;
        }

        // 2. Identifica todas as unidades (apelidos) no seu histórico
        const lojas = await db.collection('historico_precos').distinct("estabelecimento");
        const ranking = [];

        for (const loja of lojas) {
            let totalLoja = 0;
            let itensEncontrados = 0;

            for (const item of listaAtiva) {
                // Busca o preço mais recente deste item nesta loja específica através do dicionário
                const vinculo = await db.collection('dicionario_produtos').findOne({ 
                    nome_comum: item.item_nome.toUpperCase() 
                });

                if (vinculo) {
                    const historico = await db.collection('historico_precos').aggregate([
                        { $match: { estabelecimento: loja } },
                        { $unwind: "$itens" },
                        { $match: { "itens.id_interno": { $in: vinculo.ids_vinculados } } },
                        { $sort: { data_compra: -1 } },
                        { $limit: 1 }
                    ]).toArray();

                    if (historico.length > 0) {
                        totalLoja += historico[0].itens.preco_unitario * (item.quantidade || 1);
                        itensEncontrados++;
                    }
                }
            }

            if (itensEncontrados > 0) {
                ranking.push({
                    nome: loja,
                    total: totalLoja,
                    itensEncontrados: itensEncontrados,
                    totalItensLista: listaAtiva.length
                });
            }
        }

        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: ranking.sort((a, b) => a.total - b.total) // Mais barato no topo
        };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};