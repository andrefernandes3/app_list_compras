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
            
            // 1. TENTATIVA POR ID (Sempre a prioridade para evitar erros)
            if (prod.ids_vinculados && prod.ids_vinculados.length > 0) {
                for (let id of prod.ids_vinculados) {
                    try {
                        const url = `https://carrefourbr.vtexcommercestable.com.br/api/catalog_system/pub/products/search?fq=productId:${id}`;
                        const res = await fetch(url);
                        const data = await res.json();
                        
                        // Verifica se existe o produto e a estrutura de vendedor
                        if (Array.isArray(data) && data.length > 0) {
                            const item = data[0];
                            
                            // 2. FILTRO DE VENDEDOR: Só aceita se for vendido pelo Carrefour
                            const vendedorOficial = item.items[0].sellers.find(s => 
                                s.sellerName.toLowerCase().includes("carrefour")
                            );

                            if (vendedorOficial) {
                                const oferta = vendedorOficial.commertialOffer;
                                resultado = { 
                                    seu_item: prod.nome_comum, 
                                    item_oficial: item.productName,
                                    preco_site: oferta.Price,
                                    // link correto fornecido pela API
                                    link_site: item.link, 
                                    status: oferta.Price > 0 ? "ENCONTRADO" : "SEM ESTOQUE"
                                };
                                break; // Sai do loop de IDs se achou o oficial
                            }
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