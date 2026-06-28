const https = require('https');

module.exports = async function (context, req) {
    const { ean, loja, sc } = req.query;

    const hosts = {
        'SAMS': 'www.samsclub.com.br',
        'CARREFOUR': 'www.carrefour.com.br',
        'ATACADAO': 'www.atacadao.com.br'
    };

    if (!ean || !hosts[loja]) {
        context.res = { status: 400, body: "Parâmetros errados." };
        return;
    }

    const path = `/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}${sc ? '&sc=' + sc : ''}`;

    // Função que encapsula a requisição em uma Promise
    const fetchData = (targetUrl, isRedirect = false) => {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(targetUrl);
            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            };

            const reqHttp = https.request(options, (res) => {
                // SE FOR REDIRECIONAMENTO (301/302), REPETE O FETCH NA NOVA URL
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return resolve(fetchData(res.headers.location, true));
                }

                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => resolve(data));
            });

            reqHttp.on('error', (err) => reject(err));
            reqHttp.end();
        });
    };

    try {
        const initialUrl = `https://${hosts[loja]}${path}`;
        const responseBody = await fetchData(initialUrl);
        const data = JSON.parse(responseBody);

        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: data
        };
    } catch (e) {
        // Se der erro, mostra no navegador o que aconteceu
        context.res = {
            status: 500,
            body: { erro: "Erro no processamento", detalhe: e.message }
        };
    }
};