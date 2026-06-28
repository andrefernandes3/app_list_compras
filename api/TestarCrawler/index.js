const fetch = require('node-fetch');

module.exports = async function (context, req) {
    // Ex: /api/TestarPrecoCEP?ean=7891000123456&loja=ATACADAO&sc=2
    const { ean, loja, sc } = req.query;
    
    const configs = {
        'SAMS': { host: 'https://www.samsclub.com.br' },
        'CARREFOUR': { host: 'https://www.carrefour.com.br' },
        'ATACADAO': { host: 'https://www.atacadao.com.br' }
    };

    if (!ean || !configs[loja]) {
        context.res = { status: 400, body: "Use ?ean=...&loja=ATACADAO&sc=..." };
        return;
    }

    try {
        // Monta a URL com o Sales Channel (sc) descoberto
        let url = `${configs[loja].host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}`;
        if (sc) url += `&sc=${sc}`;

        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await res.json();

        if (data && data.length > 0) {
            const item = data[0];
            const sellers = item.items[0].sellers;
            context.res = { 
                status: 200, 
                body: { 
                    nome: item.productName,
                    sellers: sellers.map(s => ({ name: s.sellerName, preco: s.commertialOffer.Price })) 
                } 
            };
        } else {
            context.res = { status: 404, body: { erro: "Não encontrado" } };
        }
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    }
};