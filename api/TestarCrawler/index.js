const { MongoClient } = require('mongodb');

// Função Juiz: Score de similaridade
function calcularScore(nomeBanco, nomeSite) {
    const palavrasBanco = nomeBanco.toUpperCase().split(' ').filter(p => p.length > 2);
    const textoSite = nomeSite.toUpperCase();
    return palavrasBanco.reduce((score, palavra) => textoSite.includes(palavra) ? score + 1 : score, 0);
}

module.exports = async function (context, req) {
    const loja = (req.query.loja || 'SAMS').toUpperCase();
    const configs = {
        'SAMS': { host: 'https://www.samsclub.com.br' },
        'CARREFOUR': { host: 'https://www.carrefour.com.br' }
    };

    if (!configs[loja]) {
        context.res = { status: 400, body: { erro: "Loja não suportada." } };
        return;
    }

    let client = null;
    let relatorio = { loja, resultados: [] };

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        const colecao = db.collection('dicionario_produtos');
        const monitorados = await colecao.find({ monitorar: true }).toArray();

        for (const prod of monitorados) {
            let resultado = { seu_item: prod.nome_comum, status: "NÃO ENCONTRADO" };
            let produtoEncontrado = null;

            // 1. TENTATIVA POR ID (SÓ USA O QUE VOCÊ CADASTROU MANUALMENTE)
            if (prod.ids_vinculados && prod.ids_vinculados.length > 0) {
                const id = prod.ids_vinculados[0];
                const res = await fetch(`${configs[loja].host}/api/catalog_system/pub/products/search?fq=productId:${id}`);
                const data = res.ok ? await res.json() : [];
                if (data && data.length > 0) produtoEncontrado = data[0];
            }

            // 2. TENTATIVA POR BUSCA INTELIGENTE (APENAS LEITURA, NUNCA GRAVA NO BANCO)
            if (!produtoEncontrado) {
                const termo = encodeURIComponent(prod.nome_comum.split(' ').slice(0, 2).join(' '));
                const res = await fetch(`${configs[loja].host}/api/catalog_system/pub/products/search/${termo}?_from=0&_to=20`);
                const data = res.ok ? await res.json() : [];
                
                if (data && data.length > 0) {
                    const melhorMatch = data.find(item => calcularScore(prod.nome_comum, item.productName) >= 3);
                    if (melhorMatch) {
                        produtoEncontrado = melhorMatch;
                        // Log de Auditoria: Ele te avisa o que achou, mas NÃO mexe no seu banco.
                        context.log(`[AUDITORIA] Item: ${prod.nome_comum} encontrado via busca com ID: ${melhorMatch.productId}. Verifique se é correto.`);
                    }
                }
            }

            // Finaliza o processamento
            if (produtoEncontrado) {
                const oferta = produtoEncontrado.items[0].sellers[0].commertialOffer;
                resultado = { 
                    seu_item: prod.nome_comum, 
                    item_oficial: produtoEncontrado.productName,
                    id_usado: produtoEncontrado.productId,
                    preco_site: oferta.Price, 
                    status: oferta.Price > 0 ? "ENCONTRADO" : "SEM ESTOQUE" 
                };
            }
            relatorio.resultados.push(resultado);
        }
        context.res = { status: 200, body: relatorio };
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};