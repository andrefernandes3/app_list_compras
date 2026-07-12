const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// 1. FUNÇÃO DE BUSCA (A que você comprovou que funciona)
// ============================================================================
const buscarDadosAtacadao = (url) => {
    return new Promise((resolve) => {
        const options = {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        };
        https.get(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
            });
        }).on('error', () => resolve(null)).end();
    });
};

// ============================================================================
// 2. FUNÇÃO PRINCIPAL (Focada apenas no Atacadão)
// ============================================================================
module.exports = async function (context, req) {
    let client = null;
    const REGION_ID = 'v2.8CB7CC2FFB5F56CD19FB23952C3277A6';
    let logResultados = [];

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        
        // Busca apenas produtos ativos com EAN
        const monitorados = await db.collection('dicionario_produtos')
            .find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();

        for (const prod of monitorados) {
            // URL idêntica à que funcionou no MonitorarPrecos
            const url = `https://www.atacadao.com.br/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${prod.ean}&sc=1&regionId=${REGION_ID}&_=${Date.now()}`;
            
            const data = await buscarDadosAtacadao(url);
            
            if (data && data.length > 0) {
                const item = data[0];
                const seller = item.items[0].sellers.find(s => s.commertialOffer.Price > 0);
                const preco = seller ? seller.commertialOffer.Price : 0;
                
                if (preco > 0) {
                    // Grava histórico
                    await db.collection('historico_precos_web').insertOne({
                        nome: prod.nome_comum,
                        ean: prod.ean,
                        loja: "Atacadão",
                        preco: preco,
                        data_verificacao: new Date()
                    });
                    
                    logResultados.push({ produto: prod.nome_comum, status: "ENCONTRADO", preco: preco });
                } else {
                    logResultados.push({ produto: prod.nome_comum, status: "SEM ESTOQUE", preco: 0 });
                }
            } else {
                logResultados.push({ produto: prod.nome_comum, status: "NÃO ENCONTRADO", preco: 0 });
            }
        }

        context.res = { 
            status: 200, 
            headers: { "Content-Type": "application/json" },
            body: { mensagem: "Atacadão processado com sucesso.", resultados: logResultados }
        };

    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};