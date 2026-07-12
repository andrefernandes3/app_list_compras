const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// 1. CONFIGURAÇÕES DAS LOJAS E REGIÕES (SC - Sales Channel)
// ============================================================================
const configs = [
    { 
        id: 'SAMS', 
        nome: "Sam's Club", 
        host: 'https://www.samsclub.com.br', 
        // sc: '1' -> Padrão Nacional (Costuma trazer Cotia ou estoque central)
        // Substitua pelo SC de Osasco quando descobrir no console (ex: sc: '3')
        sc: '1' 
    },
    { 
        id: 'CARREFOUR', 
        nome: "Carrefour", 
        host: 'https://www.carrefour.com.br', 
        // Carrefour costuma funcionar bem com o SC 1 para todas as regiões
        sc: '1' 
    },
    { 
        id: 'ATACADAO', 
        nome: "Atacadão", 
        host: 'https://www.atacadao.com.br', 
        // sc: '1' -> Padrão Nacional
        // Se retornar "SEM ESTOQUE", coloque o SC da loja física de Osasco aqui
        sc: '1' 
    }
];

// ============================================================================
// 2. FUNÇÃO AUXILIAR DE REQUISIÇÃO (Blindada contra erros e redirecionamentos)
// ============================================================================
const buscarDadosVtex = (targetUrl) => {
    return new Promise((resolve) => {
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
            // Se o servidor tentar redirecionar (301/302), o robô segue a nova URL
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let novaUrl = res.headers.location;
                if (novaUrl.startsWith('/')) novaUrl = `https://${urlObj.hostname}${novaUrl}`;
                return resolve(buscarDadosVtex(novaUrl));
            }

            // Se der erro de firewall (403) ou não encontrado (404), resolve nulo suavemente
            if (res.statusCode !== 200) {
                return resolve(null);
            }

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } 
                catch (e) { resolve(null); }
            });
        });

        reqHttp.on('error', () => resolve(null));
        reqHttp.end();
    });
};

// ============================================================================
// 3. FUNÇÃO PRINCIPAL (Loop e Processamento)
// ============================================================================
module.exports = async function (context, req) {
    let client = null;
    let relatorio = [];

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        
        // Melhoria: Traz do banco APENAS os itens com monitorar: true e que possuem um EAN válido
        const monitorados = await db.collection('dicionario_produtos')
            .find({ monitorar: true, ean: { $exists: true, $ne: "" } })
            .toArray();

        for (const prod of monitorados) {
            
            // MELHORIA DE PERFORMANCE: Dispara a busca nas 3 lojas SIMULTANEAMENTE
            const promessasBusca = configs.map(async (lojaConfig) => {
                try {
                    // Monta a URL garantindo o EAN, o SC correto e ignorando cache da loja (_)
                    const urlEan = `${lojaConfig.host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${prod.ean}&sc=${lojaConfig.sc}&_=${Date.now()}`;
                    
                    const data = await buscarDadosVtex(urlEan);

                    if (data && data.length > 0) {
                        const item = data[0];
                        const sellerAtivo = item.items[0].sellers[0];
                        
                        const precoAtual = sellerAtivo.commertialOffer.Price;
                        // Extrai a origem real para você confirmar se é Osasco, Cotia, etc.
                        const nomeLojaOrigem = sellerAtivo.sellerName; 

                        return {
                            produto: prod.nome_comum,
                            loja: lojaConfig.nome,
                            origem: nomeLojaOrigem, 
                            status: precoAtual > 0 ? "ENCONTRADO" : "SEM ESTOQUE",
                            preco: precoAtual > 0 ? precoAtual : 0
                        };
                    } else {
                        return { 
                            produto: prod.nome_comum, 
                            loja: lojaConfig.nome, 
                            origem: "N/A", 
                            status: "NÃO ENCONTRADO" 
                        };
                    }
                } catch (err) {
                    return { produto: prod.nome_comum, loja: lojaConfig.nome, origem: "ERRO", status: "ERRO" };
                }
            });

            // Aguarda a resposta simultânea das 3 lojas para este produto antes de prosseguir
            const resultadosDoProduto = await Promise.all(promessasBusca);
            relatorio.push(...resultadosDoProduto);
        }

        context.res = { 
            status: 200, 
            headers: { "Content-Type": "application/json" },
            body: relatorio 
        };
        
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};