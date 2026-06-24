const { MongoClient } = require('mongodb');

// Função Juiz: Quanto mais palavras iguais, maior o Score
function calcularScore(nomeBanco, nomeSite) {
    const palavrasBanco = nomeBanco.toUpperCase().split(' ').filter(p => p.length > 2);
    const textoSite = nomeSite.toUpperCase();
    return palavrasBanco.reduce((score, palavra) => textoSite.includes(palavra) ? score + 1 : score, 0);
}

module.exports = async function (context, req) {
    let relatorio = { resultados: [] };
    let client = null;

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        const colecao = db.collection('dicionario_produtos');

        const monitorados = await colecao.find({ monitorar: true }).toArray();
        
        for (const prod of monitorados) {
            let resultado = { seu_item: prod.nome_comum, status: "NÃO ENCONTRADO" };
            let usadoSniper = false;

            // 1. TENTATIVA SNIPER (URL EXATA)
            if (prod.url_sams && typeof prod.url_sams === 'string' && prod.url_sams.includes('samsclub.com.br')) {
                try {
                    const slug = prod.url_sams.split('/').filter(p => p && !['p', 'produto'].includes(p.toLowerCase())).pop();
                    const res = await fetch(`https://www.samsclub.com.br/api/catalog_system/pub/products/search/${slug}`);
                    const data = res.ok ? await res.json() : [];
                    if (data && data.length > 0) {
                        const oferta = data[0].items[0].sellers[0].commertialOffer;
                        resultado = { seu_item: prod.nome_comum, estrategia: "LINK EXATO 🎯", preco_site: oferta.Price, status: "ENCONTRADO" };
                        usadoSniper = true;
                    }
                } catch (e) { context.log("Erro no link:", e.message); }
            }

            // 2. TENTATIVA SCORE (A VERSÃO QUE VOCÊ GOSTAVA)
            if (!usadoSniper) {
                try {
                    const termo = encodeURIComponent(prod.nome_comum.split(' ').slice(0, 2).join(' '));
                    const res = await fetch(`https://www.samsclub.com.br/api/catalog_system/pub/products/search/${termo}?_from=0&_to=49`);
                    const data = res.ok ? await res.json() : [];
                    
                    if (data && data.length > 0) {
                        let melhorMatch = null;
                        let maiorScore = -1;

                        data.forEach(item => {
                            const score = calcularScore(prod.nome_comum, item.productName);
                            if (score > maiorScore) {
                                maiorScore = score;
                                melhorMatch = item;
                            }
                        });

                        if (melhorMatch && maiorScore >= 1) {
                            const oferta = melhorMatch.items[0].sellers[0].commertialOffer;
                            resultado = { 
                                seu_item: prod.nome_comum, 
                                estrategia: "BUSCA/SCORE 🔍", 
                                preco_site: oferta.Price, 
                                status: "ENCONTRADO" 
                            };
                        }
                    }
                } catch (e) { context.log("Erro busca:", e.message); }
            }
            relatorio.resultados.push(resultado);
        }
        context.res = { status: 200, body: relatorio };
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};