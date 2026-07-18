const { MongoClient } = require('mongodb');
const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const nomeProduto = req.query.nome;
    const dias = parseInt(req.query.dias) || 0;

    try {
        await client.connect();
        const db = client.db('app_compras');

        let matchStage = {};

        // 1. Lógica flexível: Busca por nome se enviado, caso contrário, busca tudo
        if (nomeProduto) {
            const produto = await db.collection('dicionario_produtos').findOne({ 
                nome_comum: nomeProduto.toUpperCase() 
            });

            if (!produto) {
                context.res = { status: 404, body: [] };
                return;
            }
            matchStage = { "itens.id_interno": { $in: produto.ids_vinculados } };
        }

        // 2. Filtro de data (opcional)
        if (dias > 0) {
            const dataLimite = new Date();
            dataLimite.setDate(dataLimite.getDate() - dias);
            dataLimite.setHours(0, 0, 0, 0);
            matchStage["data_compra"] = { $gte: dataLimite };
        }

        // 3. Busca o histórico
        // Se matchStage estiver vazio, ele trará registros de todos os produtos
        const pipeline = [
            { $unwind: "$itens" },
            { $match: matchStage },
            { $sort: { data_compra: -1 } }, // Traz os mais recentes primeiro
            {
                $project: {
                    _id: 0,
                    data: "$data_compra",
                    preco: "$itens.preco_unitario",
                    mercado: "$estabelecimento",
                    nome: "$itens.descricao" // Adicionado para identificar no frontend
                }
            }
        ];

        // Se não houver filtro de produto específico, limitamos para não sobrecarregar
        if (!nomeProduto) pipeline.splice(2, 0, { $limit: 1000 });

        const historico = await db.collection('historico_precos').aggregate(pipeline).toArray();

        context.res = { 
            status: 200, 
            headers: { "Content-Type": "application/json" },
            body: historico 
        };
    } catch (error) {
        context.log.error('Erro na API ObterHistorico:', error);
        context.res = { status: 500, body: error.message };
    } finally {
        await client.close();
    }
};