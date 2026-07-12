const https = require('https');
const { MongoClient } = require('mongodb');

// Função de busca dedicada ao Atacadão (VTEX)
const buscarNoAtacadao = (ean, regionId) => {
    return new Promise((resolve) => {
        // SC 1 é a política padrão, mas para o Atacadão em Osasco, 
        // a região é o fator determinante do estoque.
        const url = `https://www.atacadao.com.br/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}&sc=1&regionId=${regionId}&_=${Date.now()}`;
        
        // Headers otimizados para evitar bloqueio Anti-Bot
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
        
        // Pegamos o regionId fixo de Osasco que você já usa
        const REGION_ID = 'v2.8CB7CC2FFB5F56CD19FB23952C3277A6';
        
        const monitorados = await db.collection('dicionario_produtos')
            .find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();

        for (const prod of monitorados) {
            const data = await buscarNoAtacadao(prod.ean, REGION_ID);
            
            if (data && data.length > 0) {
                const item = data[0];
                const seller = item.items[0].sellers.find(s => s.commertialOffer.Price > 0);
                
                if (seller) {
                    const precoAtual = seller.commertialOffer.Price;
                    
                    // Grava o histórico apenas se for diferente do último (otimização que fizemos)
                    const ultimoPreco = await db.collection('historico_precos_web')
                        .find({ nome: prod.nome_comum, loja: "Atacadão" })
                        .sort({ data_verificacao: -1 }).limit(1).toArray();
                    
                    if (ultimoPreco.length === 0 || ultimoPreco[0].preco !== precoAtual) {
                        await db.collection('historico_precos_web').insertOne({
                            nome: prod.nome_comum, ean: prod.ean, loja: "Atacadão",
                            preco: precoAtual, data_verificacao: new Date()
                        });
                    }
                }
            }
        }
        context.res = { status: 200, body: "Busca no Atacadão concluída." };
    } catch (e) {
        context.res = { status: 500, body: e.message };
    } finally {
        if (client) await client.close();
    }
};