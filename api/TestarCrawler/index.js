const { MongoClient } = require('mongodb');

// 🛠️ Função 1: Tira pesos e medidas que bugam o site
function limparTermoBusca(nome) {
    return nome.replace(/[0-9]+(,[0-9]+)?\s*(KG|G|ML|L)\b/gi, '').trim();
}

// 🛠️ Função 2: O Robô Juiz (Dá nota para o produto da loja)
function calcularScoreDeMatch(nomeBanco, nomeSite) {
    const palavrasBanco = nomeBanco.toUpperCase().split(' ').filter(p => p.length > 2);
    const textoSite = nomeSite.toUpperCase();
    let score = 0;
    palavrasBanco.forEach(palavra => {
        if (textoSite.includes(palavra)) score++;
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
            let resolveuComSniper = false;

            try {
                // ==========================================
                // 🔥 ESTRATÉGIA 1: TIRO DE SNIPER (URL EXATA)
                // ==========================================
                if (prod.url_sams && prod.url_sams.includes('samsclub.com.br')) {
                    try {
                        const urlObj = new URL(prod.url_sams);
                        
                        // Divide a URL pelas barras '/' e joga fora palavras inúteis como 'p' ou 'produto'
                        const partesCaminho = urlObj.pathname.split('/').filter(p => p && p.toLowerCase() !== 'p' && p.toLowerCase() !== 'produto');
                        
                        if (partesCaminho.length > 0) {
                            // O slug real (nome descritivo do produto no link) sempre será a última parte restante
                            const slug = partesCaminho[partesCaminho.length - 1];
                            
                            // Dispara a busca usando o slug exato do produto
                            const urlApiExata = `https://www.samsclub.com.br/api/catalog_system/pub/products/search/${slug}`;
                            
                            const response = await fetch(urlApiExata, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                            const data = response.ok ? await response.json() : [];
                            
                            if (data && data.length > 0) {
                                const produtoSite = data[0];
                                const oferta = produtoSite.items[0].sellers[0].commertialOffer;
                                const precoCapturado = oferta.Price;
                                
                                relatorio.resultados.push({ 
                                    seu_item: prod.nome_comum, 
                                    estrategia_usada: "LINK EXATO 🎯",
                                    item_oficial: produtoSite.productName,
                                    preco_site: precoCapturado,
                                    status: precoCapturado === 0 ? 'SEM ESTOQUE' : 'ENCONTRADO' 
                                });
                                resolveuComSniper = true;
                            }
                        }
                    } catch (e) {
                        relatorio.passos.push(`Erro ao tentar ler a URL do item: ${prod.nome_comum}`);
                    }
                }

                // ==========================================
                // 🌊 ESTRATÉGIA 2: REDE DE ARRASTO (FALLBACK)
                // ==========================================
                if (!resolveuComSniper) {
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
                                estrategia_usada: "BUSCA/SCORE 🔍",
                                nota_de_precisao: maiorScore,
                                preco_site: precoCapturado,
                                status: precoCapturado === 0 ? 'SEM ESTOQUE' : 'ENCONTRADO' 
                            });
                        }
                    } else {
                        relatorio.resultados.push({ seu_item: prod.nome_comum, status: "Não encontrado" });
                    }
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