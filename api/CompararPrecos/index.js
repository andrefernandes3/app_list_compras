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

        // 1. Pega todos os vínculos de uma vez só (Batch)
        const nomesLista = listaAtiva.map(i => i.item_nome.toUpperCase());
        const dicionario = await db.collection('dicionario_produtos')
            .find({ nome_comum: { $in: nomesLista } }).toArray();

        // Mapa de IDs para busca rápida
        const todosIdsVinculados = dicionario.flatMap(d => d.ids_vinculados);
        const mapaNomePorId = {};
        dicionario.forEach(d => {
            d.ids_vinculados.forEach(id => mapaNomePorId[id] = d.nome_comum);
        });

        // 2. Busca TODO o histórico de preços desses itens em uma ÚNICA consulta
        const historicoCompleto = await db.collection('historico_precos').aggregate([
            { $unwind: "$itens" },
            { $match: { "itens.id_interno": { $in: todosIdsVinculados } } },
            { $sort: { data_compra: -1 } }, // Do mais novo para o mais velho
            { $group: {
                _id: { loja: "$estabelecimento", nome: { $let: { vars: { id: "$itens.id_interno" }, in: { $arrayElemAt: [dicionario, 0] } } } }, 
                // Simplificando o agrupamento para performance[cite: 3]
                nomeAmigavel: { $first: "" }, 
                idInterno: { $first: "$itens.id_interno" },
                estabelecimento: { $first: "$estabelecimento" },
                precoMin: { $min: "$itens.preco_unitario" },
                precoUltimo: { $first: "$itens.preco_unitario" }
            }}
        ]).toArray();

        // 3. Montagem dos resultados em memória (muito mais rápido que no banco)[cite: 3]
        const precosPorLoja = {};
        const precosIndividuais = {};
        const mapaOcorrencias = {};

        historicoCompleto.forEach(h => {
            const nomeAmigavel = mapaNomePorId[h.idInterno];
            if (!nomeAmigavel) return;

            if (!precosPorLoja[h.estabelecimento]) precosPorLoja[h.estabelecimento] = {};
            precosPorLoja[h.estabelecimento][nomeAmigavel] = h.precoUltimo;

            mapaOcorrencias[nomeAmigavel] = (mapaOcorrencias[nomeAmigavel] || 0) + 1;

            if (!precosIndividuais[nomeAmigavel] || h.precoMin < precosIndividuais[nomeAmigavel].valor) {
                precosIndividuais[nomeAmigavel] = { loja: h.estabelecimento, valor: h.precoMin };
            }
        });

        const itensEmComum = Object.keys(mapaOcorrencias).filter(nome => mapaOcorrencias[nome] > 1);

        const ranking = Object.keys(precosPorLoja).map(loja => {
            let totalJusto = 0;
            let encontradosNomes = [];
            itensEmComum.forEach(nomeItem => {
                if (precosPorLoja[loja][nomeItem]) {
                    const itemLista = listaAtiva.find(i => i.item_nome.toUpperCase() === nomeItem);
                    totalJusto += precosPorLoja[loja][nomeItem] * (itemLista.quantidade || 1);
                    encontradosNomes.push(nomeItem);
                }
            });
            return { nome: loja, total: totalJusto, encontrados: encontradosNomes.length, totalItens: itensEmComum.length, itensNomes: encontradosNomes };
        }).filter(l => l.encontrados > 0).sort((a, b) => a.total - b.total);

        context.res = { status: 200, body: { ranking, precosIndividuais, itensEmComum } };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};