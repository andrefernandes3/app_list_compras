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
            let fullUrl = targetUrl;
            if (!isRedirect && fullUrl.includes('carrefour.com.br')) {
                fullUrl += (fullUrl.includes('?') ? '&' : '?') + `_=${Date.now()}`;
            }
            if (fullUrl.startsWith('/')) {
                fullUrl = `https://${hosts[loja]}${fullUrl}`;
            }
            
            const urlObj = new URL(fullUrl);
            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: 'GET',
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json'
                }
            };

            const reqHttp = https.request(options, (res) => {
                // Se for redirecionamento, segue
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return resolve(fetchData(res.headers.location, true));
                }

                // AQUI ESTÁ A MUDANÇA: Verifica se houve erro de status antes de ler
                if (res.statusCode !== 200) {
                    return reject(new Error("Status HTTP: " + res.statusCode));
                }

                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (!data) reject(new Error("Resposta vazia do servidor"));
                    else resolve(data);
                });
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