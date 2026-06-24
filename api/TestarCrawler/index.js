const { MongoClient } = require('mongodb');

// Função Juiz: Avalia a similaridade entre o que você busca e o que o site entrega
function calcularScore(nomeBanco, nomeSite) {
    const palavrasBanco = nomeBanco.toUpperCase().split(' ').filter(p => p.length > 2);
    const textoSite = nomeSite.toUpperCase();
    return palavrasBanco.reduce((score, palavra) => textoSite.includes(palavra) ? score + 1 : score, 0);
}

module.exports = async function (context, req) {
    // Define qual mercado buscar (padrão é SAMS se não informado)
    const loja = (req.query.loja || 'SAMS').toUpperCase();
    const configs = {
        'SAMS': { host: 'https://www.samsclub.com.br' },
        'CARREFOUR': { host: 'https://www.carrefour.com.br' }
    };

    if (!configs[loja]) {
        context.res = { status: 400, body: { erro: "Loja não suportada. Use SAMS ou CARREFOUR." } };
        return;
    }

    let relatorio = { loja, resultados: [] };
    let client = null;

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const colecao = client.db('app_compras').collection('dicionario_produtos');
        const monitorados = await colecao.find({ monitorar: true }).toArray();
        
        for (const prod of monitorados) {
            let resultado = { seu_item: prod.nome_comum, status: "NÃO ENCONTRADO" };
            
            try {
                // Motor de Busca Universal VTEX
                const termo = encodeURIComponent(prod.nome_comum.split(' ').slice(0, 2).join(' '));
                const url = `${configs[loja].host}/api/catalog_system/pub/products/search/${termo}?_from=0&_to=20`;
                
                const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
                            item_oficial_site: melhorMatch.productName,
                            nota_de_precisao: maiorScore,
                            preco_site: oferta.Price, 
                            status: oferta.Price > 0 ? "ENCONTRADO" : "SEM ESTOQUE" 
                        };
                    }
                }
            } catch (e) { context.log(`Erro em ${prod.nome_comum}:`, e.message); }
            
            relatorio.resultados.push(resultado);
        }
        context.res = { status: 200, body: relatorio };
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};