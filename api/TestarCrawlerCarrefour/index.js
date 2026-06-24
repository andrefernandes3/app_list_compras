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
            
            // 1. TENTATIVA POR ID (MUITO MAIS PRECISO)
            if (prod.ids_vinculados && prod.ids_vinculados.length > 0) {
                // Tenta buscar usando os IDs que você já vinculou no banco
                for (let id of prod.ids_vinculados) {
                    try {
                        const url = `https://carrefourbr.vtexcommercestable.com.br/api/catalog_system/pub/products/search?fq=productId:${id}`;
                        const res = await fetch(url);
                        const data = await res.json();
                        
                        // Verifica se a API retornou algo válido e se tem a estrutura de itens
                        if (Array.isArray(data) && data.length > 0 && data[0].items && data[0].items[0]) {
                            const oferta = data[0].items[0].sellers[0].commertialOffer;
                            resultado = { 
                                seu_item: prod.nome_comum, 
                                item_oficial: data[0].productName,
                                preco_site: oferta.Price,
                                status: oferta.Price > 0 ? "ENCONTRADO" : "SEM ESTOQUE"
                            };
                            break; // Se achou com um ID, para de procurar pelos outros
                        }
                    } catch (e) { continue; }
                }
            }
            
            relatorio.resultados.push(resultado);
        }
        context.res = { body: relatorio };
    } catch (e) { 
        context.res = { status: 500, body: e.message }; 
    }
    finally { await client.close(); }
};