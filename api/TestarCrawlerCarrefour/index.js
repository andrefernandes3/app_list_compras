const { MongoClient } = require('mongodb');

module.exports = async function (context, req) {
    let client = new MongoClient(process.env["MONGODB_URI"]);
    let relatorio = { loja: "CARREFOUR", resultados: [] };

    context.log("🔍 DETETIVE INICIADO: Começando varredura Carrefour...");

    try {
        await client.connect();
        const col = client.db('app_compras').collection('dicionario_produtos');
        const monitorados = await col.find({ monitorar: true }).toArray();

        context.log(`📊 Itens monitorados encontrados: ${monitorados.length}`);

        for (const prod of monitorados) {
            let resultado = { seu_item: prod.nome_comum, status: "NÃO ENCONTRADO" };
            
            const termo = encodeURIComponent(prod.nome_comum.split(' ').slice(0, 2).join(' '));
            const url = `https://www.carrefour.com.br/api/catalog_system/pub/products/search/${termo}?_from=0&_to=10`;
            
            context.log(`🔗 Buscando: ${prod.nome_comum} -> URL: ${url}`);

            try {
                const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                
                if (!res.ok) {
                    context.log(`❌ Erro na requisição para ${prod.nome_comum}: Status ${res.status}`);
                    continue;
                }

                const data = await res.json();
                context.log(`📦 Itens retornados pelo Carrefour para '${prod.nome_comum}': ${data.length}`);

                if (data.length > 0) {
                    // Logamos o primeiro item encontrado para debug
                    context.log(`✅ Exemplo de retorno: ${data[0].productName}`);
                    
                    const oferta = data[0].items[0].sellers[0].commertialOffer;
                    resultado = { 
                        seu_item: prod.nome_comum, 
                        item_oficial: data[0].productName,
                        preco_site: oferta.Price,
                        status: "ENCONTRADO"
                    };
                } else {
                    context.log(`⚠️ Nenhum produto encontrado para: ${prod.nome_comum}`);
                }
            } catch (e) { 
                context.log(`💥 Erro crítico no item ${prod.nome_comum}: ${e.message}`); 
            }
            relatorio.resultados.push(resultado);
        }
        context.res = { body: relatorio };
    } catch (e) { 
        context.log(`🔥 ERRO GERAL: ${e.message}`);
        context.res = { status: 500, body: e.message }; 
    }
    finally { await client.close(); }
};