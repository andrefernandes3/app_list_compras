const { MongoClient } = require('mongodb');

// 🛠️ Função auxiliar 1: Remove pesos e medidas que atrapalham a busca na VTEX
function limparTermoBusca(nome) {
    return nome.replace(/[0-9]+(,[0-9]+)?\s*(KG|G|ML|L)\b/gi, '').trim();
}

// 🛠️ Função auxiliar 2: Conta quantas palavras o produto do site tem em comum com o seu
function calcularScoreDeMatch(nomeBanco, nomeSite) {
    // Pega palavras maiores que 2 letras
    const palavrasBanco = nomeBanco.toUpperCase().split(' ').filter(p => p.length > 2);
    const palavrasSite = nomeSite.toUpperCase().split(' ');
    
    let score = 0;
    palavrasBanco.forEach(palavra => {
        if (palavrasSite.includes(palavra)) {
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
            let data = [];
            
            try {
                // TENTATIVA 1: Nome limpo (sem pesos e medidas)
                let termoBusca = limparTermoBusca(prod.nome_comum);
                let urlSams = `https://www.samsclub.com.br/api/catalog_system/pub/products/search/${encodeURIComponent(termoBusca)}`;
                
                let response = await fetch(urlSams, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                data = response.ok ? await response.json() : [];

                // TENTATIVA 2: Busca Cirúrgica (3 primeiras palavras apenas) se a primeira falhar
                if (data.length === 0) {
                    const nomeCurto = termoBusca.split(' ').slice(0, 3).join(' '); // Ex: "SUCO INTEGRAL MAÇÃ"
                    urlSams = `https://www.samsclub.com.br/api/catalog_system/pub/products/search/${encodeURIComponent(nomeCurto)}`;
                    response = await fetch(urlSams, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                    data = response.ok ? await response.json() : [];
                }
                
                if (data && data.length > 0) {
                    // 🧠 LÓGICA DO MELHOR MATCH: Analisa todos os retornos do Sam's Club
                    let melhorProduto = null;
                    let maiorScore = -1;

                    for (const itemSite of data) {
                        const scoreAtual = calcularScoreDeMatch(prod.nome_comum, itemSite.productName);
                        if (scoreAtual > maiorScore) {
                            maiorScore = scoreAtual;
                            melhorProduto = itemSite;
                        }
                    }

                    const nomeOficialSite = melhorProduto.productName;
                    const oferta = melhorProduto.items[0].sellers[0].commertialOffer;
                    const precoCapturado = oferta.Price;
                    const estoque = oferta.AvailableQuantity;
                    
                    relatorio.resultados.push({ 
                        seu_item: prod.nome_comum, 
                        item_que_o_robo_achou: nomeOficialSite,
                        score_de_precisao: maiorScore,
                        preco_site: precoCapturado, 
                        estoque_site: estoque,
                        status: precoCapturado === 0 ? 'SEM ESTOQUE' : 'ENCONTRADO' 
                    });
                } else {
                    relatorio.resultados.push({ seu_item: prod.nome_comum, status: "Não encontrado no catálogo" });
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