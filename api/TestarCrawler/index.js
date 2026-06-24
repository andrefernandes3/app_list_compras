const { MongoClient } = require('mongodb');

module.exports = async function (context, req) {
    let relatorio = { passos: [], resultados: [] };
    let client = null;

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        const colecao = db.collection('dicionario_produtos');

        const monitorados = await colecao.find({ monitorar: true }).toArray();
        
        for (const prod of monitorados) {
            let resultadoFinal = null;
            let usadoSniper = false;

            // 1. TENTATIVA SNIPER (URL EXATA) - PRIORIDADE MÁXIMA
            if (prod.url_sams && prod.url_sams.includes('samsclub.com.br')) {
                try {
                    const urlObj = new URL(prod.url_sams);
                    const partes = urlObj.pathname.split('/').filter(p => p && !['p', 'produto'].includes(p.toLowerCase()));
                    const slug = partes[partes.length - 1];
                    
                    const res = await fetch(`https://www.samsclub.com.br/api/catalog_system/pub/products/search/${slug}`);
                    const data = res.ok ? await res.json() : [];
                    
                    if (data && data.length > 0) {
                        const oferta = data[0].items[0].sellers[0].commertialOffer;
                        resultadoFinal = { 
                            seu_item: prod.nome_comum, 
                            estrategia: "LINK EXATO 🎯", 
                            preco_site: oferta.Price, 
                            status: oferta.Price > 0 ? "ENCONTRADO" : "SEM ESTOQUE" 
                        };
                        usadoSniper = true;
                    }
                } catch (e) { context.log("Erro no link Sniper:", e.message); }
            }

            // 2. TENTATIVA BUSCA (Fallback) - SÓ RODA SE O SNIPER FALHAR
            if (!usadoSniper) {
                try {
                    const termo = encodeURIComponent(prod.nome_comum.split(' ').slice(0, 2).join(' '));
                    const res = await fetch(`https://www.samsclub.com.br/api/catalog_system/pub/products/search/${termo}?_from=0&_to=10`);
                    const data = res.ok ? await res.json() : [];
                    
                    if (data && data.length > 0) {
                        const oferta = data[0].items[0].sellers[0].commertialOffer;
                        resultadoFinal = { 
                            seu_item: prod.nome_comum, 
                            estrategia: "BUSCA 🔍", 
                            preco_site: oferta.Price, 
                            status: "ENCONTRADO" 
                        };
                    } else {
                        resultadoFinal = { seu_item: prod.nome_comum, status: "NÃO ENCONTRADO" };
                    }
                } catch (e) { resultadoFinal = { seu_item: prod.nome_comum, erro: e.message }; }
            }

            relatorio.resultados.push(resultadoFinal);
        }

        context.res = { status: 200, body: relatorio };
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};