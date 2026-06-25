const { MongoClient } = require('mongodb');

// Função Juiz: Avalia a similaridade de palavras
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

        // Foco exclusivo no Sam's Club
        const hostSams = "https://www.samsclub.com.br";

        for (const prod of monitorados) {
            const menorPrecoHistorico = await obterMenorPrecoHistorico(db, prod.nome_comum);
            const precoReferencia = prod.preco_alvo || menorPrecoHistorico;
            
            if (precoReferencia === Infinity) continue;

            // Usa as duas primeiras palavras para a busca na API
            const termo = encodeURIComponent(prod.nome_comum.split(' ').slice(0, 2).join(' '));
            const url = `${hostSams}/api/catalog_system/pub/products/search/${termo}?_from=0&_to=10`;
            
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const data = res.ok ? await res.json() : [];

            let melhorMatch = null;
            let maiorScore = -1;

            if (data && data.length > 0) {
                data.forEach(item => {
                    const nomeSite = item.productName.toUpperCase();
                    const nomeBanco = prod.nome_comum.toUpperCase();
                    
                    // 1. Validação de Palavras Exclusivas (Evita trocar Wickbold por Pullman)
                    // Se o item do banco tem "WICKBOLD", o do site PRECISA ter "WICKBOLD"
                    const palavrasChaveBanco = nomeBanco.split(' ').filter(p => p.length > 4); // Palavras longas (marcas/especificações)
                    const marcasConhecidas = ["WICKBOLD", "PULLMAN", "NATURAL", "MELITTA", "NIVEA", "NINHO", "UNIÃO"];
                    
                    let marcaIncompativel = false;
                    palavrasChaveBanco.forEach(palavra => {
                        if (marcasConhecidas.includes(palavra) && !nomeSite.includes(palavra)) {
                            marcaIncompativel = true; 
                        }
                    });

                    if (marcaIncompativel) return; // Ignora este item do site completamente

                    // 2. Trava de Volume Simplificada (L vs ML / G vs KG)
                    const temGramas = (n) => n.includes('G') && !n.includes('KG');
                    const temKilos = (n) => n.includes('KG') || n.includes('KILO');
                    const volumeBate = (temGramas(nomeSite) === temGramas(nomeBanco)) && (temKilos(nomeSite) === temKilos(nomeBanco));

                    // 3. Cálculo do Score
                    const score = calcularScore(nomeBanco, nomeSite);
                    
                    // No Sam's Club o filtro pode ser score >= 2 para garantir precisão
                    if (score >= 2 && volumeBate && score > maiorScore) {
                        maiorScore = score;
                        melhorMatch = item;
                    }
                });
            }

            // 4. Se encontrou um match legítimo, valida o preço
            if (melhorMatch) {
                const precoAtual = melhorMatch.items[0].sellers[0].commertialOffer.Price;
                
                if (precoAtual < precoReferencia && precoAtual > 0) {
                    await alertasCol.insertOne({
                        produto_nome: prod.nome_comum,
                        loja: "SAMS",
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

        context.res = { 
            status: 200, 
            body: { 
                message: "Monitoramento Sam's Club concluído.", 
                total_alertas: totalAlertas
            } 
        };
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        await client.close();
    }
};

async function obterMenorPrecoHistorico(db, nomeProduto) {
    const primeiraPalavra = nomeProduto.split(' ')[0];
    
    const pipeline = [
        { $unwind: "$itens" },
        { $match: { "itens.descricao": { $regex: primeiraPalavra, $options: 'i' } } },
        { $group: { _id: null, menorPreco: { $min: "$itens.preco_unitario" } } }
    ];
    
    const cursor = await db.collection("historico_precos").aggregate(pipeline).toArray();
    return cursor.length > 0 ? cursor[0].menorPreco : Infinity;
}
