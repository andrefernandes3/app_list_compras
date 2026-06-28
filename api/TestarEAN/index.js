const { MongoClient } = require('mongodb');

module.exports = async function (context, req) {
    // Exemplo de chamada: /api/TestarEAN?ean=7894900702008&loja=ATACADAO
    const { ean, loja } = req.query;
    
    const hosts = {
        'SAMS': 'https://www.samsclub.com.br',
        'CARREFOUR': 'https://www.carrefour.com.br',
        'ATACADAO': 'https://www.atacadao.com.br'
    };

    if (!ean || !hosts[loja]) {
        context.res = { status: 400, body: "Parâmetros errados. Use ?ean=...&loja=ATACADAO" };
        return;
    }

    try {
        // A sintaxe padrão da VTEX para busca por EAN (alternateIds)
        const url = `${hosts[loja]}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}`;
        
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await response.json();

        if (data && data.length > 0) {
            const item = data[0];
            // Garante que pegamos o preço da oferta principal
            const preco = item.items[0].sellers[0].commertialOffer.Price;
            
            context.res = { 
                status: 200, 
                body: { 
                    status: "MATCH_PERFEITO",
                    nome_encontrado: item.productName,
                    preco: preco,
                    loja: loja 
                } 
            };
        } else {
            context.res = { status: 404, body: { status: "EAN_NAO_ENCONTRADO" } };
        }
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    }
};