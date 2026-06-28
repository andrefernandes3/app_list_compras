const https = require('https');

module.exports = async function (context, req) {
    const { ean, loja, sc } = req.query;
    
    // 1. Usar o WWW para evitar o erro 301
    const hosts = {
        'SAMS': 'www.samsclub.com.br',
        'CARREFOUR': 'www.carrefour.com.br',
        'ATACADAO': 'www.atacadao.com.br'
    };

    if (!ean || !hosts[loja]) {
        context.res = { status: 400, body: "Parâmetros errados." };
        return;
    }

    const options = {
        hostname: hosts[loja],
        path: `/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}${sc ? '&sc=' + sc : ''}`,
        method: 'GET',
        headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        }
    };

    const reqHttp = https.request(options, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
            // Se for 301 ou 302, precisamos tratar, mas com o WWW deve resolver
            if (res.statusCode >= 300 && res.statusCode < 400) {
                context.res = { status: 500, body: { erro: "Redirecionamento bloqueado. Tente ajustar o host." } };
            } else {
                try {
                    context.res = { status: 200, body: JSON.parse(data) };
                } catch (e) {
                    context.res = { status: 500, body: { erro: "JSON Inválido: " + data.substring(0, 50) } };
                }
            }
        });
    });

    reqHttp.on('error', (e) => {
        context.res = { status: 500, body: { erro: e.message } };
    });
    reqHttp.end();
};