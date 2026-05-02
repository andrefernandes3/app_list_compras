const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const nomeProduto = req.query.nome; // Usado para a pílula individual

    try {
        await client.connect();
        const db = client.db('app_compras');

        // CASO 1: Se houver um NOME na URL, retorna o melhor preço desse item (Pílula)
        if (nomeProduto) {
            const vinculo = await db.collection('dicionario_produtos').findOne({ 
                nome_comum: nomeProduto.toUpperCase() 
            });
            if (!vinculo) return context.res = { status: 200, body: [] };

            const comparativo = await db.collection('historico_precos').aggregate([
                { $unwind: "$itens" },
                { $match: { "itens.id_interno": { $in: vinculo.ids_vinculados } } },
                { $group: {
                    _id: "$estabelecimento",
                    menorPreco: { $min: "$itens.preco_unitario" }
                }},
                { $sort: { menorPreco: 1 } }
            ]).toArray();

            return context.res = { status: 200, body: comparativo };
        }

        // CASO 2: Se NÃO houver nome, faz o Ranking Geral do Carrinho
        const listaAtiva = await db.collection('lista_compras').find({}).toArray();
        const lojas = await db.collection('historico_precos').distinct("estabelecimento");
        const ranking = [];

        for (const loja of lojas) {
            let totalLoja = 0;
            let encontrados = 0;
            for (const item of listaAtiva) {
                const v = await db.collection('dicionario_produtos').findOne({ nome_comum: item.item_nome.toUpperCase() });
                if (v) {
                    const h = await db.collection('historico_precos').aggregate([
                        { $match: { estabelecimento: loja } },
                        { $unwind: "$itens" },
                        { $match: { "itens.id_interno": { $in: v.ids_vinculados } } },
                        { $sort: { data_compra: -1 } }, { $limit: 1 }
                    ]).toArray();
                    if (h.length > 0) {
                        totalLoja += h[0].itens.preco_unitario * (item.quantidade || 1);
                        encontrados++;
                    }
                }
            }
            if (encontrados > 0) ranking.push({ nome: loja, total: totalLoja, encontrados, totalItens: listaAtiva.length });
        }
        context.res = { status: 200, body: ranking.sort((a, b) => a.total - b.total) };

    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};