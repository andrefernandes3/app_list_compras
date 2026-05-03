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
                    // BUSCA GLOBAL: Removemos o $sort e $limit para pegar o menor de todos
                    const h = await db.collection('historico_precos').aggregate([
                        { $match: { estabelecimento: loja } },
                        { $unwind: "$itens" },
                        { $match: { "itens.id_interno": { $in: vinculo.ids_vinculados } } },
                        { $group: { 
                            _id: null, 
                            menorPreco: { $min: "$itens.preco_unitario" },
                            ultimoPreco: { $last: "$itens.preco_unitario" } // Mantemos o último para o Ranking
                        }}
                    ]).toArray();

                    if (h.length > 0) {
                        const precoMinimo = h[0].menorPreco;
                        const precoUltimo = h[0].ultimoPreco;

                        // O Ranking usa o preço mais recente (realista para a compra de hoje)
                        precosPorLoja[loja][item.item_nome] = precoUltimo;
                        mapaOcorrencias[item.item_nome] = (mapaOcorrencias[item.item_nome] || 0) + 1;

                        // A Pílula mostra o MELHOR de todos os tempos
                        if (!precosIndividuais[item.item_nome] || precoMinimo < precosIndividuais[item.item_nome].valor) {
                            precosIndividuais[item.item_nome] = { loja: loja, valor: precoMinimo };
                        }
                    }
                }
            }
        }

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
            return { nome: loja, total: totalJusto, encontrados: encontradosNomes.length, totalItens: itensEmComum.length, itensNomes: encontradosNomes };
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