const { MongoClient } = require('mongodb');

function calcularScore(nomeBanco, nomeSite) {
    const palavrasBanco = nomeBanco.toUpperCase().split(' ').filter(p => p.length > 2);
    const textoSite = nomeSite.toUpperCase();
    return palavrasBanco.reduce((score, palavra) => textoSite.includes(palavra) ? score + 1 : score, 0);
}

module.exports = async function (context, req) {
    const uri = process.env.MONGODB_URI;
    const client = new MongoClient(uri);
    
    try {
        await client.connect();
        const db = client.db('app_compras');
        const dicionarioCol = db.collection('dicionario_produtos');
        const alertasCol = db.collection('alertas_preco');
        
        const monitorados = await dicionarioCol.find({ monitorar: true }).toArray();
        let totalAlertas = 0;

        const lojas = [
            { nome: "CARREFOUR", host: "https://www.carrefour.com.br", minScore: 2 },
            { nome: "SAMS", host: "https://www.samsclub.com.br", minScore: 1 }
        ];

        for (const prod of monitorados) {
            // 1. Define preço de referência (Alvo manual > Histórico > Infinity)
            const menorPrecoHistorico = await obterMenorPrecoHistorico(db, prod.nome_comum);
            const precoReferencia = prod.preco_alvo || menorPrecoHistorico;
            
            if (precoReferencia === Infinity) continue;

            for (const loja of lojas) {
                const termo = encodeURIComponent(prod.nome_comum.split(' ').slice(0, 2).join(' '));
                const url = `${loja.host}/api/catalog_system/pub/products/search/${termo}?_from=0&_to=20`;
                
                const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                const data = res.ok ? await res.json() : [];

                let melhorMatch = null;
                let maiorScore = -1;

                data.forEach(item => {
                    const nomeSite = item.productName.toUpperCase();
                    const nomeBanco = prod.nome_comum.toUpperCase();
                    
                    const volumeRegex = /(\d+[\.,]?\d*\s?[L|G|ML])/i;
                    const vBusca = nomeBanco.match(volumeRegex);
                    const vSite = nomeSite.match(volumeRegex);
                    const volumeBate = vBusca && vSite ? vBusca[0].replace(',', '.') === vSite[0].replace(',', '.') : true;

                    const score = calcularScore(nomeBanco, nomeSite);
                    
                    // LOGS DE DEBUG
                    if (score < loja.minScore) context.log(`DEBUG: Reprovado no Score (Score: ${score}) - ${nomeSite}`);
                    if (!volumeBate) context.log(`DEBUG: Reprovado no Volume (Buscado: ${vBusca ? vBusca[0] : 'n/a'} / Site: ${vSite ? vSite[0] : 'n/a'})`);

                    if (score >= loja.minScore && volumeBate && score > maiorScore) {
                        maiorScore = score;
                        melhorMatch = item;
                    }
                });

                if (melhorMatch) {
                    const precoAtual = melhorMatch.items[0].sellers[0].commertialOffer.Price;
                    
                    if (precoAtual < precoReferencia && precoAtual > 0) {
                        await alertasCol.insertOne({
                            produto_nome: prod.nome_comum,
                            loja: loja.nome,
                            preco_historico: precoReferencia,
                            preco_atual: precoAtual,
                            link_compra: melhorMatch.link,
                            data_alerta: new Date(),
                            status_notificacao: "pendente"
                        });
                        totalAlertas++;
                    }
                }
            }
        }
        context.res = { status: 200, body: { message: "Monitoramento concluído.", total_alertas: totalAlertas } };
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        await client.close();
    }
};

async function obterMenorPrecoHistorico(db, nomeProduto) {
    const volume = nomeProduto.match(/(\d+[\.,]?\d*\s?[L|G|ML])/i);
    const volumeRegex = volume ? volume[0] : "";
    
    const pipeline = [
        { $unwind: "$itens" },
        { $match: { "itens.descricao": { $regex: nomeProduto.split(' ')[0], $options: 'i' } } }
    ];
    
    if (volumeRegex) {
        pipeline.push({ $match: { "itens.descricao": { $regex: volumeRegex, $options: 'i' } } });
    }
    
    pipeline.push({ $group: { _id: null, menorPreco: { $min: "$itens.preco_unitario" } } });

    const cursor = await db.collection("historico_precos").aggregate(pipeline).toArray();
    return cursor.length > 0 ? cursor[0].menorPreco : Infinity;
}