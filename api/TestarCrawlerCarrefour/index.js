const { MongoClient } = require('mongodb');

// Função de Score (Lógica compartilhada)
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
            
            // Busca mais ampla para o Carrefour
            const termo = encodeURIComponent(prod.nome_comum.split(' ').slice(0, 2).join(' '));
            const url = `https://www.carrefour.com.br/api/catalog_system/pub/products/search/${termo}?_from=0&_to=10`;
            
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const data = res.ok ? await res.json() : [];

            if (data.length > 0) {
                // Em vez de rejeitar tudo, pegamos o melhor score entre os resultados
                let best = null;
                let maxScore = 0;
                data.forEach(item => {
                    const s = calcularScore(prod.nome_comum, item.productName);
                    if (s > maxScore) { maxScore = s; best = item; }
                });

                if (best && maxScore >= 1) { // Nota baixa de 1 já permite encontrar algo
                    const oferta = best.items[0].sellers[0].commertialOffer;
                    resultado = { 
                        seu_item: prod.nome_comum, 
                        item_oficial: best.productName,
                        nota: maxScore,
                        preco_site: oferta.Price,
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