const { MongoClient } = require('mongodb');

module.exports = async function (context, req) {
    // Captura o 'ean' ou o 'nome' do produto a partir da URL (ex: /api/ObterHistorico?ean=789123456)
    const ean = req.query.ean;
    const nome = req.query.nome;

    if (!ean && !nome) {
        context.res = {
            status: 400,
            body: { erro: "Informe o 'ean' ou o 'nome' do produto na Query String." }
        };
        return;
    }

    let client = null;

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');

        // Monta o filtro dinâmico
        const filtro = {};
        if (ean) filtro.ean = ean;
        else if (nome) filtro.nome = new RegExp(nome, 'i'); // Busca 'case-insensitive'

        // Busca o histórico ordenado da data mais antiga para a mais recente (ideal para gráficos)
        const historico = await db.collection('historico_precos_web')
            .find(filtro)
            .sort({ data_verificacao: 1 }) 
            .toArray();

        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: historico
        };

    } catch (error) {
        context.log.error('Erro ao buscar histórico:', error);
        context.res = {
            status: 500,
            body: { erro: "Erro ao consultar histórico de preços." }
        };
    } finally {
        if (client) await client.close();
    }
};