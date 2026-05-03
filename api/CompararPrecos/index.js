const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    try {
        await client.connect();
        const db = client.db('app_compras');

        const listaAtiva = await db.collection('lista_compras').find({}).toArray();
        if (listaAtiva.length === 0) {
            return context.res = { status: 200, body: { ranking: [], precosIndividuais: {} } };
        }

        const lojas = await db.collection('historico_precos').distinct("estabelecimento");
        const ranking = [];
        const precosIndividuais = {};

        for (const loja of lojas) {
            let totalLoja = 0;
            let encontradosCount = 0; // Nome corrigido
            let itensNaLoja = [];     // Inicializado para o Tooltip

            for (const item of listaAtiva) {
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
                        itensNaLoja.push(item.item_nome); // Adiciona para o Tooltip

                        if (!precosIndividuais[item.item_nome] || preco < precosIndividuais[item.item_nome].valor) {
                            precosIndividuais[item.item_nome] = { loja: loja, valor: preco };
                        }
                    }
                }
            }
            
            if (encontradosCount > 0) {
                const cobertura = (encontradosCount / listaAtiva.length) * 100;
                ranking.push({
                    nome: loja,
                    total: totalLoja,
                    encontrados: encontradosCount,
                    totalItens: listaAtiva.length,
                    cobertura: cobertura,
                    itensNomes: itensNaLoja 
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