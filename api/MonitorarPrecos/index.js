const { MongoClient } = require('mongodb');

// Função Juiz: Mantemos a mesma lógica que já funciona bem
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

        // Configuração das lojas
        const lojas = [
            { nome: "CARREFOUR", host: "https://www.carrefour.com.br", minScore: 2 },
            { nome: "SAMS", host: "https://www.samsclub.com.br", minScore: 1 }
        ];

        for (const prod of monitorados) {
            // 1. Busca Histórico
            const menorPrecoHistorico = await obterMenorPrecoHistorico(db, prod.nome_comum);
            if (menorPrecoHistorico === Infinity) continue;

            // 2. Tenta encontrar em cada loja
            for (const loja of lojas) {
                const termo = encodeURIComponent(prod.nome_comum.split(' ').slice(0, 2).join(' '));
                const url = `${loja.host}/api/catalog_system/pub/products/search/${termo}?_from=0&_to=20`;
                
                const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                const data = res.ok ? await res.json() : [];

                let melhorMatch = null;
                let maiorScore = -1;

                data.forEach(item => {
                    const score = calcularScore(prod.nome_comum, item.productName);
                    if (score > maiorScore) {
                        maiorScore = score;
                        melhorMatch = item;
                    }
                });

                // 3. Valida se achou e se o preço é vantajoso
                if (melhorMatch && maiorScore >= loja.minScore) {
                    const precoAtual = melhorMatch.items[0].sellers[0].commertialOffer.Price;
                    
                    if (precoAtual < menorPrecoHistorico && precoAtual > 0) {
                        await alertasCol.insertOne({
                            produto_nome: prod.nome_comum,
                            loja: loja.nome,
                            preco_historico: menorPrecoHistorico,
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

// Função que busca no historico_precos usando o NOME do produto
async function obterMenorPrecoHistorico(db, nomeProduto) {
    const cursor = await db.collection("historico_precos").aggregate([
        { $unwind: "$itens" },
        { $match: { "itens.descricao": { $regex: nomeProduto.split(' ')[0], $options: 'i' } } },
        { $group: { _id: null, menorPreco: { $min: "$itens.preco_unitario" } } }
    ]).toArray();
    return cursor.length > 0 ? cursor[0].menorPreco : Infinity;
}