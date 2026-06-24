const { MongoClient } = require('mongodb');

// Função Juiz (mantemos apenas como fallback)
function calcularScore(nomeBanco, nomeSite) {
    const pBanco = nomeBanco.toUpperCase().split(' ').filter(p => p.length > 2);
    const pSite = nomeSite.toUpperCase();
    return pBanco.reduce((s, p) => pSite.includes(p) ? s + 1 : s, 0);
}

module.exports = async function (context, req) {
    let client = new MongoClient(process.env["MONGODB_URI"]);
    let relatorio = { loja: "CARREFOUR", resultados: [] };

    try {
        await client.connect();
        const col = client.db('app_compras').collection('dicionario_produtos');
        const monitorados = await col.find({ monitorar: true }).toArray();

        for (const prod of monitorados) {
            let resultado = { seu_item: prod.nome_comum, status: "NÃO ENCONTRADO" };
            let produtoEncontrado = null;

            // 1. TENTATIVA POR ID (MUITO MAIS PRECISO)
            if (prod.ids_vinculados && prod.ids_vinculados.length > 0) {
                // Tenta usar o primeiro ID da lista (que você já cadastrou)
                const id = prod.ids_vinculados[0];
                const urlId = `https://carrefourbr.vtexcommercestable.com.br/api/catalog_system/pub/products/search?fq=productId:${id}`;
                const res = await fetch(urlId);
                const data = await res.json();
                
                if (data.length > 0) {
                    produtoEncontrado = data[0];
                }
            }

            // 2. TENTATIVA POR BUSCA (APENAS FALLBACK)
            if (!produtoEncontrado) {
                const termo = encodeURIComponent(prod.nome_comum.split(' ').slice(0, 2).join(' '));
                const urlBusca = `https://www.carrefour.com.br/api/catalog_system/pub/products/search/${termo}?_from=0&_to=10`;
                
                const res = await fetch(urlBusca, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                const data = res.ok ? await res.json() : [];

                if (data.length > 0) {
                    // Filtro mais rígido para evitar falsos positivos
                    const best = data.find(item => calcularScore(prod.nome_comum, item.productName) > 2);
                    if (best) produtoEncontrado = best;
                }
            }

            // Finaliza o processamento
            if (produtoEncontrado) {
                const oferta = produtoEncontrado.items[0].sellers[0].commertialOffer;
                resultado = { 
                    seu_item: prod.nome_comum, 
                    item_oficial: produtoEncontrado.productName,
                    preco_site: oferta.Price,
                    status: oferta.Price > 0 ? "ENCONTRADO" : "SEM ESTOQUE"
                };
            }
            relatorio.resultados.push(resultado);
        }
        context.res = { body: relatorio };
    } catch (e) { context.res = { status: 500, body: e.message }; }
    finally { await client.close(); }
};