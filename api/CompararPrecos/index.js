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
        const nomesLista = listaAtiva.map(i => i.item_nome.toUpperCase());
        const dicionario = await db.collection('dicionario_produtos').find({ nome_comum: { $in: nomesLista } }).toArray();

        const todosIds = dicionario.flatMap(d => d.ids_vinculados);
        const mapaIdParaNome = {};
        dicionario.forEach(d => {
            d.ids_vinculados.forEach(id => mapaIdParaNome[id] = d.nome_comum);
        });

        // Busca em lote: Único aggregate para todos os preços de todas as lojas
        const historico = await db.collection('historico_precos').aggregate([
            { $unwind: "$itens" },
            { $match: { "itens.id_interno": { $in: todosIds } } },
            { $group: {
                _id: { loja: "$estabelecimento", idProd: "$itens.id_interno" },
                precoMin: { $min: "$itens.preco_unitario" },
                precoUltimo: { $last: "$itens.preco_unitario" },
                loja: { $first: "$estabelecimento" }
            }}
        ]).toArray();

        const precosPorLoja = {};
        const precosIndividuais = {};
        const mapaOcorrencias = {};

        historico.forEach(h => {
            const nomeAmigavel = mapaIdParaNome[h._id.idProd];
            if (!precosPorLoja[h.loja]) precosPorLoja[h.loja] = {};
            
            // O Ranking usa o preço mais recente
            precosPorLoja[h.loja][nomeAmigavel] = h.precoUltimo;
            mapaOcorrencias[nomeAmigavel] = (mapaOcorrencias[nomeAmigavel] || 0) + 1;

            // A Pílula usa o mínimo histórico (ex: R$ 4,00 do leite)[cite: 4]
            if (!precosIndividuais[nomeAmigavel] || h.precoMin < precosIndividuais[nomeAmigavel].valor) {
                precosIndividuais[nomeAmigavel] = { valor: h.precoMin, loja: h.loja };
            }
        });

        const itensEmComum = Object.keys(mapaOcorrencias).filter(nome => mapaOcorrencias[nome] > 1);

        const ranking = lojas.map(loja => {
            let totalJusto = 0;
            let encontradosNomes = [];
            itensEmComum.forEach(nomeItem => {
                if (precosPorLoja[loja] && precosPorLoja[loja][nomeItem]) {
                    const itemRef = listaAtiva.find(i => i.item_nome.toUpperCase() === nomeItem.toUpperCase());
                    totalJusto += precosPorLoja[loja][nomeItem] * (itemRef.quantidade || 1);
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