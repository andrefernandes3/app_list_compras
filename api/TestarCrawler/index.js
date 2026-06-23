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
                
                // 1. A REDE DE ARRASTO: Pega só as 2 primeiras palavras para vir de tudo
                let nomeCurto = termoBusca.split(' ').slice(0, 2).join(' ');
                
                // 2. FORÇA A LOJA A TRAZER 50 ITENS (_from=0&_to=49)
                let urlSams = `https://www.samsclub.com.br/api/catalog_system/pub/products/search/${encodeURIComponent(nomeCurto)}?_from=0&_to=49`;
                
                let response = await fetch(urlSams, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                let data = response.ok ? await response.json() : [];
                
                if (data && data.length > 0) {
                    let melhorProduto = null;
                    let maiorScore = -1;

                    // 3. JULGAMENTO: Lê os 50 produtos e acha o gêmeo exato do seu banco
                    for (const itemSite of data) {
                        const scoreAtual = calcularScoreDeMatch(termoBusca, itemSite.productName);
                        if (scoreAtual > maiorScore) {
                            maiorScore = scoreAtual;
                            melhorProduto = itemSite;
                        }
                    }

                    if (melhorProduto) {
                        const nomeOficialSite = melhorProduto.productName;
                        const oferta = melhorProduto.items[0].sellers[0].commertialOffer;
                        const precoCapturado = oferta.Price;
                        
                        relatorio.resultados.push({ 
                            seu_item: prod.nome_comum, 
                            item_que_o_robo_achou: nomeOficialSite,
                            nota_de_precisao: maiorScore,
                            preco_site: precoCapturado,
                            status: precoCapturado === 0 ? 'SEM ESTOQUE (ou só físico)' : 'ENCONTRADO' 
                        });
                    }
                } else {
                    relatorio.resultados.push({ seu_item: prod.nome_comum, status: "Não encontrado no catálogo VTEX" });
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