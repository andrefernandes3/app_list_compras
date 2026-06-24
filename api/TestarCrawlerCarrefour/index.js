const { MongoClient } = require('mongodb');

// Função Juiz: Mais rigorosa
function calcularScore(nomeBanco, nomeSite) {
    const palavrasBanco = nomeBanco.toUpperCase().split(' ').filter(p => p.length > 2);
    const textoSite = nomeSite.toUpperCase();
    return palavrasBanco.reduce((score, palavra) => textoSite.includes(palavra) ? score + 1 : score, 0);
}

module.exports = async function (context, req) {
    let relatorio = { loja: "CARREFOUR", resultados: [] };
    let client = null;

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const colecao = client.db('app_compras').collection('dicionario_produtos');
        const monitorados = await colecao.find({ monitorar: true }).toArray();
        
        for (const prod of monitorados) {
            let resultado = { seu_item: prod.nome_comum, status: "NÃO ENCONTRADO" };
            
            try {
                // 🔥 MELHORIA: Busca segmentada (forçando a VTEX do Carrefour a ser mais específica)
                const termo = encodeURIComponent(prod.nome_comum.split(' ').slice(0, 3).join(' '));
                const url = `https://www.carrefour.com.br/api/catalog_system/pub/products/search/${termo}?_from=0&_to=15&O=OrderByScoreDESC`;
                
                const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                const data = res.ok ? await res.json() : [];
                
                if (data && data.length > 0) {
                    // 🔥 FILTRO DE SEGURANÇA: Só aceita se o nome do item no site contiver pelo menos 2 palavras-chave
                    const palvChave = prod.nome_comum.split(' ').filter(p => p.length > 3);
                    const melhorMatch = data.find(item => 
                        palvChave.every(p => item.productName.toUpperCase().includes(p.toUpperCase()))
                    );

                    if (melhorMatch) {
                        const oferta = melhorMatch.items[0].sellers[0].commertialOffer;
                        resultado = { 
                            seu_item: prod.nome_comum, 
                            item_oficial_site: melhorMatch.productName,
                            preco_site: oferta.Price, 
                            status: oferta.Price > 0 ? "ENCONTRADO" : "SEM ESTOQUE" 
                        };
                    }
                }
            } catch (e) { context.log(`Erro Carrefour ${prod.nome_comum}:`, e.message); }
            
            relatorio.resultados.push(resultado);
        }
        context.res = { status: 200, body: relatorio };
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};