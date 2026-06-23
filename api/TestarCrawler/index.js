const { MongoClient } = require('mongodb');

module.exports = async function (context, req) {
    let relatorio = { passos: [], resultados: [] };
    let client = null;

    try {
        const uri = process.env["MONGODB_URI"];
        client = new MongoClient(uri);
        await client.connect();

        const db = client.db('app_compras');
        const colecao = db.collection('dicionario_produtos');

        const monitorados = await colecao.find({ monitorar: true }).toArray();
        relatorio.passos.push(`Itens com monitorar=true encontrados: ${monitorados.length}`);

        if (monitorados.length === 0) {
            context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { erro: "Nenhum item marcado para monitorar." } };
            return;
        }

        for (const prod of monitorados) {
            let nomeBusca = prod.nome_comum;
            let urlSams = `https://www.samsclub.com.br/api/catalog_system/pub/products/search/${encodeURIComponent(nomeBusca)}`;
            
            try {
                // TENTATIVA 1: Busca pelo nome completo
                let response = await fetch(urlSams, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                let data = response.ok ? await response.json() : [];

                // TENTATIVA 2: Busca Ampla (Apenas as 2 primeiras palavras do produto)
                if (data.length === 0) {
                    const nomeCurto = prod.nome_comum.split(' ').slice(0, 2).join(' '); // Ex: Pega só "QUEIJO MUÇARELA"
                    urlSams = `https://www.samsclub.com.br/api/catalog_system/pub/products/search/${encodeURIComponent(nomeCurto)}`;
                    response = await fetch(urlSams, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                    data = response.ok ? await response.json() : [];
                }
                
                if (data && data.length > 0) {
                    const precoCapturado = data[0].items[0].sellers[0].commertialOffer.Price;
                    relatorio.resultados.push({ item: prod.nome_comum, preco_site: precoCapturado, status: 'ENCONTRADO' });
                } else {
                    relatorio.resultados.push({ item: prod.nome_comum, status: "Não encontrado nem com busca curta" });
                }
            } catch (err) {
                relatorio.resultados.push({ item: prod.nome_comum, erro: err.message });
            }
        }

        context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: relatorio };
    } catch (error) {
        context.res = { status: 500, headers: { "Content-Type": "application/json" }, body: { erro: error.message } };
    } finally {
        if (client) await client.close();
    }
};