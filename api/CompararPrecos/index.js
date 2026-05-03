const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    try {
        await client.connect();
        const db = client.db('app_compras');

        const listaAtiva = await db.collection('lista_compras').find({}).toArray();
        if (listaAtiva.length === 0) {
            return context.res = { status: 200, body: { ranking: [], precosIndividuais: {}, itensEmComum: [] } };
        }

        const lojas = await db.collection('historico_precos').distinct("estabelecimento");
        
        // Mapa para identificar quais itens existem em quais lojas
        let precosPorLoja = {}; 
        let mapaOcorrencias = {};
        const precosIndividuais = {};

        for (const loja of lojas) {
            precosPorLoja[loja] = {};
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
                        precosPorLoja[loja][item.item_nome] = preco;
                        
                        // Conta em quantas lojas este item aparece
                        mapaOcorrencias[item.item_nome] = (mapaOcorrencias[item.item_nome] || 0) + 1;

                        // Cache para a pílula de sugestão (melhor preço de todos)
                        if (!precosIndividuais[item.item_nome] || preco < precosIndividuais[item.item_nome].valor) {
                            precosIndividuais[item.item_nome] = { loja: loja, valor: preco };
                        }
                    }
                }
            }
        }

        // Filtra apenas itens que aparecem em MAIS DE UMA LOJA para o Ranking Justo
        const itensEmComum = Object.keys(mapaOcorrencias).filter(nome => mapaOcorrencias[nome] > 1);

        const ranking = lojas.map(loja => {
            let totalJusto = 0;
            let encontradosNomes = [];

            itensEmComum.forEach(nomeItem => {
                if (precosPorLoja[loja][nomeItem]) {
                    const qtd = listaAtiva.find(i => i.item_nome === nomeItem).quantidade || 1;
                    totalJusto += precosPorLoja[loja][nomeItem] * qtd;
                    encontradosNomes.push(nomeItem);
                }
            });

            return {
                nome: loja,
                total: totalJusto,
                encontrados: encontradosNomes.length,
                totalItens: itensEmComum.length,
                itensNomes: encontradosNomes
            };
        }).filter(l => l.encontrados > 0).sort((a, b) => a.total - b.total);

        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: { ranking, precosIndividuais, itensEmComum }
        };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};