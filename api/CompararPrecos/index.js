const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    try {
        await client.connect();
        const db = client.db('app_compras');

        // 1. Busca os itens ativos na sua lista
        const listaAtiva = await db.collection('lista_compras').find({}).toArray();
        if (listaAtiva.length === 0) {
            return context.res = { status: 200, body: { ranking: [], precosIndividuais: {} } };
        }

        // 2. Mapeia todos os estabelecimentos do seu histórico em Osasco
        const lojas = await db.collection('historico_precos').distinct("estabelecimento");
        const ranking = [];
        const precosIndividuais = {}; 

        for (const loja of lojas) {
            let totalLoja = 0;
            let encontradosCount = 0;

            for (const item of listaAtiva) {
                // Busca o vínculo no dicionário para saber quais IDs procurar
                const vinculo = await db.collection('dicionario_produtos').findOne({ 
                    nome_comum: item.item_nome.toUpperCase() 
                });

                if (vinculo) {
                    const h = await db.collection('historico_precos').aggregate([
                        { $match: { estabelecimento: loja } },
                        { $unwind: "$itens" },
                        { $match: { "itens.id_interno": { $in: vinculo.ids_vinculados } } },
                        { $sort: { data_compra: -1 } },
                        { $limit: 1 }
                    ]).toArray();

                    if (h.length > 0) {
                        const preco = h[0].itens.preco_unitario;
                        totalLoja += preco * (item.quantidade || 1);
                        encontradosCount++;

                        // Lógica da Pílula: Guarda sempre o melhor preço global encontrado
                        if (!precosIndividuais[item.item_nome] || preco < precosIndividuais[item.item_nome].valor) {
                            precosIndividuais[item.item_nome] = { loja: loja, valor: preco };
                        }
                    }
                }
            }
            if (encontradosCount > 0) {
                ranking.push({ 
                    nome: loja, 
                    total: totalLoja, 
                    encontrados: encontradosCount, 
                    totalItens: listaAtiva.length 
                });
            }
        }

        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: { 
                ranking: ranking.sort((a, b) => a.total - b.total),
                precosIndividuais 
            }
        };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};