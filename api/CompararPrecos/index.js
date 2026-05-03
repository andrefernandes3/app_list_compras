const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    try {
        await client.connect();
        const db = client.db('app_compras');

        const listaAtiva = await db.collection('lista_compras').find({}).toArray();
        if (listaAtiva.length === 0) {
            return context.res = { status: 200, body: { precosIndividuais: {} } };
        }

        // 1. Mapeia todos os nomes da lista para busca em lote
        const nomesLista = listaAtiva.map(i => i.item_nome.toUpperCase());
        const dicionario = await db.collection('dicionario_produtos')
            .find({ nome_comum: { $in: nomesLista } }).toArray();

        // Cria mapa de IDs vinculados para consulta rápida
        const todosIds = dicionario.flatMap(d => d.ids_vinculados);
        const mapaIdParaNome = {};
        dicionario.forEach(d => {
            d.ids_vinculados.forEach(id => mapaIdParaNome[id] = d.nome_comum);
        });

        // 2. Busca o MENOR preço de todos esses IDs em uma ÚNICA consulta
        const precosIndividuais = {};
        const historico = await db.collection('historico_precos').aggregate([
            { $unwind: "$itens" },
            { $match: { "itens.id_interno": { $in: todosIds } } },
            { $group: {
                _id: "$itens.id_interno",
                precoMin: { $min: "$itens.preco_unitario" },
                loja: { $first: "$estabelecimento" } // Simplificado para performance[cite: 4]
            }}
        ]).toArray();

        // 3. Monta o objeto de resposta mapeando IDs de volta para nomes
        historico.forEach(h => {
            const nomeAmigavel = mapaIdParaNome[h._id];
            if (!precosIndividuais[nomeAmigavel] || h.precoMin < precosIndividuais[nomeAmigavel].valor) {
                precosIndividuais[nomeAmigavel] = { valor: h.precoMin, loja: h.loja };
            }
        });

        context.res = { status: 200, body: { precosIndividuais } };
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};