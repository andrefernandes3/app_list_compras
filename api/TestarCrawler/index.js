const { MongoClient } = require('mongodb');

// 🛠️ Função 1: Tira pesos e medidas (1KG, 500G) que bugam o site
function limparTermoBusca(nome) {
    return nome.replace(/[0-9]+(,[0-9]+)?\s*(KG|G|ML|L)\b/gi, '').trim();
}

// 🛠️ Função 2: O Robô Juiz (Dá nota para o produto da loja)
function calcularScoreDeMatch(nomeBanco, nomeSite) {
    // Pega as palavras importantes do seu dicionário
    const palavrasBanco = nomeBanco.toUpperCase().split(' ').filter(p => p.length > 2);
    const textoSite = nomeSite.toUpperCase(); // Texto corrido do site
    
    let score = 0;
    palavrasBanco.forEach(palavra => {
        if (textoSite.includes(palavra)) {
            score++;
        }
    });
    return score;
}

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
            try {
                let termoBusca = limparTermoBusca(prod.nome_comum);
                let nomeCurto = termoBusca.split(' ').slice(0, 2).join(' ');
                
                let urlSams = `https://www.samsclub.com.br/api/catalog_system/pub/products/search/${encodeURIComponent(nomeCurto)}?_from=0&_to=49`;
                let response = await fetch(urlSams, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                let data = response.ok ? await response.json() : [];
                
                if (data && data.length > 0) {
                    let melhorProduto = null;
                    let maiorScore = -1;

                    for (const itemSite of data) {
                        const scoreAtual = calcularScoreDeMatch(termoBusca, itemSite.productName);
                        
                        // 🔥 MELHORIA: Só consideramos o produto se ele bater pelo menos 2 palavras
                        // E se o preço for maior que zero
                        const preco = itemSite.items[0].sellers[0].commertialOffer.Price;
                        
                        if (scoreAtual > maiorScore && preco > 0) {
                            maiorScore = scoreAtual;
                            melhorProduto = itemSite;
                        }
                    }

                    // Se a precisão for muito baixa (score < 1), descartamos para não dar erro de produto errado
                    if (melhorProduto && maiorScore >= 1) {
                        const oferta = melhorProduto.items[0].sellers[0].commertialOffer;
                        relatorio.resultados.push({ 
                            seu_item: prod.nome_comum, 
                            item_que_o_robo_achou: melhorProduto.productName,
                            nota_de_precisao: maiorScore,
                            preco_site: oferta.Price,
                            status: "ENCONTRADO" 
                        });
                    } else {
                        relatorio.resultados.push({ seu_item: prod.nome_comum, status: "Nenhum match preciso encontrado" });
                    }
                } else {
                    relatorio.resultados.push({ seu_item: prod.nome_comum, status: "Sem resultados na busca" });
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