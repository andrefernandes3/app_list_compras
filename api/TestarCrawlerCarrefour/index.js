const { MongoClient } = require('mongodb');

module.exports = async function (context, req) {
    let relatorio = { passos: [], resultados: [] };
    let client = null;

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        const colecao = db.collection('dicionario_produtos');

        // Busca produtos com sininho ativado
        const monitorados = await colecao.find({ monitorar: true }).toArray();
        
        for (const prod of monitorados) {
            // Se o Carrefour tiver link salvo, usamos ele. Se não, tentamos a busca pelo nome.
            const urlCarrefour = prod.url_carrefour; 
            
            try {
                let preco = null;
                let status = "NÃO ENCONTRADO";

                if (urlCarrefour) {
                    // Sniper: Busca direta pelo slug da URL do Carrefour
                    const slug = urlCarrefour.split('/').filter(p => p).pop();
                    const res = await fetch(`https://www.carrefour.com.br/api/catalog_system/pub/products/search/${slug}`);
                    const data = res.ok ? await res.json() : [];
                    
                    if (data.length > 0) {
                        preco = data[0].items[0].sellers[0].commertialOffer.Price;
                        status = preco > 0 ? "ENCONTRADO" : "SEM ESTOQUE";
                    }
                } else {
                    // Busca Ampla
                    const termo = encodeURIComponent(prod.nome_comum.split(' ').slice(0, 2).join(' '));
                    const res = await fetch(`https://www.carrefour.com.br/api/catalog_system/pub/products/search/${termo}?_from=0&_to=5`);
                    const data = res.ok ? await res.json() : [];
                    
                    if (data.length > 0) {
                        preco = data[0].items[0].sellers[0].commertialOffer.Price;
                        status = "ENCONTRADO (VIA BUSCA)";
                    }
                }

                relatorio.resultados.push({ item: prod.nome_comum, preco, status });
            } catch (err) {
                relatorio.resultados.push({ item: prod.nome_comum, erro: err.message });
            }
        }
        context.res = { status: 200, body: relatorio };
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};