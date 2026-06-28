const https = require('https');

module.exports = async function (context, req) {
    const { ean, loja, sc } = req.query;
    
    const hosts = {
        'SAMS': 'samsclub.com.br',
        'CARREFOUR': 'carrefour.com.br',
        'ATACADAO': 'atacadao.com.br'
    };

    if (!ean || !hosts[loja]) {
        context.res = { status: 400, body: "Use ?ean=...&loja=ATACADAO&sc=..." };
        return;
    }

    const hostname = hosts[loja];
    let path = `/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}`;
    if (sc) path += `&sc=${sc}`;

    const options = {
        hostname: hostname,
        path: path,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' }
    };

    const promise = new Promise((resolve, reject) => {
        const reqHttp = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject("Erro ao processar JSON: " + data);
                }
            });
        });
        reqHttp.on('error', (e) => reject(e.message));
        reqHttp.end();
    });

    try {
        const data = await promise;
        if (data && data.length > 0) {
            context.res = { status: 200, body: data[0] };
        } else {
            context.res = { status: 404, body: { erro: "Não encontrado" } };
        }
    } catch (e) {
        context.res = { status: 500, body: { erro: e } };
    }
};