const https = require('https');
const { MongoClient } = require('mongodb');

// Função de busca dedicada ao Atacadão (VTEX)
const buscarNoAtacadao = (ean, regionId) => {
    return new Promise((resolve) => {
        const url = `https://www.atacadao.com.br/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}&sc=1&regionId=${regionId}&_=${Date.now()}`;
        
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

module.exports = async function (context, req) {
    let client = null;
    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        
        const REGION_ID = 'v2.8CB7CC2FFB5F56CD19FB23952C3277A6';
        const monitorados = await db.collection('dicionario_produtos')
            .find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();

        let logDetalhado = [];

        for (const prod of monitorados) {
            const data = await buscarNoAtacadao(prod.ean, REGION_ID);
            
            if (data && data.length > 0) {
                const item = data[0];
                const seller = item.items[0].sellers.find(s => s.commertialOffer.Price > 0);
                const preco = seller ? seller.commertialOffer.Price : 0;
                
                // Grava o histórico apenas se for diferente do último
                if (preco > 0) {
                    const ultimoPreco = await db.collection('historico_precos_web')
                        .find({ nome: prod.nome_comum, loja: "Atacadão" })
                        .sort({ data_verificacao: -1 }).limit(1).toArray();
                    
                    if (ultimoPreco.length === 0 || ultimoPreco[0].preco !== preco) {
                        await db.collection('historico_precos_web').insertOne({
                            nome: prod.nome_comum, ean: prod.ean, loja: "Atacadão",
                            preco: preco, data_verificacao: new Date()
                        });
                    }
                }
                
                logDetalhado.push({
                    produto: prod.nome_comum,
                    status: preco > 0 ? "ENCONTRADO" : "SEM ESTOQUE",
                    preco: preco
                });
            } else {
                logDetalhado.push({
                    produto: prod.nome_comum,
                    status: "NÃO ENCONTRADO NO CATÁLOGO",
                    preco: 0
                });
            }
        }

        context.res = { 
            status: 200, 
            headers: { "Content-Type": "application/json" },
            body: { 
                mensagem: "Busca no Atacadão concluída.",
                resultados: logDetalhado 
            } 
        };

    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};