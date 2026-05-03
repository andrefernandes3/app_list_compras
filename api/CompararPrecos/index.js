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
                // Normaliza o nome para busca no dicionário
                const nomeBusca = item.item_nome.trim().toUpperCase();

                const vinculo = await db.collection('dicionario_produtos').findOne({
                    nome_comum: nomeBusca
                });

                if (vinculo && vinculo.ids_vinculados) {
                    const h = await db.collection('historico_precos').aggregate([
                        { $match: { estabelecimento: loja } },
                        { $unwind: "$itens" },
                        { $match: { "itens.id_interno": { $in: vinculo.ids_vinculados } } },
                        { $group: { 
                            _id: null, 
                            menorPreco: { $min: "$itens.preco_unitario" },
                            ultimoPreco: { $last: "$itens.preco_unitario" }
                        }}
                    ]).toArray();

                    if (h && h.length > 0) {
                        const precoMinimo = h[0].menorPreco;
                        const precoUltimo = h[0].ultimoPreco;

                        precosPorLoja[loja][item.item_nome] = precoUltimo;
                        mapaOcorrencias[item.item_nome] = (mapaOcorrencias[item.item_nome] || 0) + 1;

                        // Pílula: Registra o menor preço absoluto da série histórica
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
                    // Busca a quantidade normalizando o nome para evitar erros de undefined[cite: 4]
                    const itemRef = listaAtiva.find(i => i.item_nome.toUpperCase() === nomeItem.toUpperCase());
                    totalJusto += precosPorLoja[loja][nomeItem] * (itemRef.quantidade || 1);
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