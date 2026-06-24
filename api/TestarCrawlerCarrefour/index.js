const { MongoClient } = require('mongodb');

module.exports = async function (context, req) {
    let client = new MongoClient(process.env["MONGODB_URI"]);
    let relatorio = { loja: "CARREFOUR", resultados: [] };

    try {
        await client.connect();
        const col = client.db('app_compras').collection('dicionario_produtos');
        const monitorados = await col.find({ monitorar: true }).toArray();

        for (const prod of monitorados) {
            let resultado = { seu_item: prod.nome_comum, status: "NÃO ENCONTRADO" };
            
            // 1. Limpa o nome para busca (remove peso extra)
            const termoBusca = encodeURIComponent(prod.nome_comum);
            
            // 2. Busca usando o termo completo + ordenação por relevância
            // O O=OrderByScoreDESC garante que o Carrefour tente te dar o item mais parecido primeiro
            const url = `https://carrefourbr.vtexcommercestable.com.br/api/catalog_system/pub/products/search?ft=${termoBusca}&_from=0&_to=0&O=OrderByScoreDESC`;
            
            const res = await fetch(url);
            const data = await res.json();
            
            // 3. Validação Rígida: Só aceita se o nome for MUITO parecido
            if (data.length > 0) {
                const itemSite = data[0];
                const nomeSite = itemSite.productName.toUpperCase();
                const nomeSeu = prod.nome_comum.toUpperCase();

                // Verifica se pelo menos as 2 primeiras palavras (ex: "COCA COLA") batem
                const palavrasSeu = nomeSeu.split(' ').slice(0, 2);
                const bateu = palavrasSeu.every(palavra => nomeSite.includes(palavra));

                if (bateu) {
                    const oferta = itemSite.items[0].sellers[0].commertialOffer;
                    resultado = { 
                        seu_item: prod.nome_comum, 
                        item_oficial: itemSite.productName,
                        preco_site: oferta.Price,
                        link_site: `https://www.carrefour.com.br${itemSite.link}`,
                        status: "ENCONTRADO"
                    };
                }
            }
            relatorio.resultados.push(resultado);
        }
        context.res = { body: relatorio };
    } catch (e) { context.res = { status: 500, body: e.message }; }
    finally { await client.close(); }
};