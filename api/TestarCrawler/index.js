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

                // TENTATIVA 2: Busca Curta (2 palavras)
                if (data.length === 0) {
                    const nomeCurto = prod.nome_comum.split(' ').slice(0, 2).join(' ');
                    urlSams = `https://www.samsclub.com.br/api/catalog_system/pub/products/search/${encodeURIComponent(nomeCurto)}`;
                    response = await fetch(urlSams, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                    data = response.ok ? await response.json() : [];
                }
                
                if (data && data.length > 0) {
                    // Pega os dados brutos oficiais que o site devolveu
                    const produtoSite = data[0];
                    const nomeOficialSite = produtoSite.productName;
                    const oferta = produtoSite.items[0].sellers[0].commertialOffer;
                    const precoCapturado = oferta.Price;
                    const estoque = oferta.AvailableQuantity;
                    
                    // Compara se o que ele achou tem a ver com o que procuramos
                    relatorio.resultados.push({ 
                        seu_item: prod.nome_comum, 
                        item_que_o_robo_achou: nomeOficialSite,
                        preco_site: precoCapturado, 
                        estoque_site: estoque,
                        status: precoCapturado === 0 ? 'SEM ESTOQUE' : 'ENCONTRADO' 
                    });
                } else {
                    relatorio.resultados.push({ seu_item: prod.nome_comum, status: "Não encontrado na API VTEX" });
                }
            } catch (err) {
                relatorio.resultados.push({ seu_item: prod.nome_comum, erro: err.message });
            }
        }

        context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: relatorio };
    } catch (error) {
        context.res = { status: 500, headers: { "Content-Type": "application/json" }, body: { erro: error.message } };
    } finally {
        if (client) await client.close();
    }
};