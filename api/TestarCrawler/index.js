const { MongoClient } = require('mongodb');

function limparTermoBusca(nome) {
    return nome.replace(/[0-9]+(,[0-9]+)?\s*(KG|G|ML|L)\b/gi, '').trim();
}

module.exports = async function (context, req) {
    let relatorio = { passos: [], resultados: [] };
    let client = null;

    try {
        const uri = process.env["MONGODB_URI"];
        client = new MongoClient(uri);
        await client.connect();

        const db = client.db('app_compras');
        const colecao = db.collection('dicionario_produtos');

        const monitorados = await colecao.find({ monitorar: true }).toArray();
        
        for (const prod of monitorados) {
            let encontrado = false;

            // 1. TENTATIVA SNIPER (URL)
            if (prod.url_sams && typeof prod.url_sams === 'string' && prod.url_sams.includes('samsclub.com.br')) {
                try {
                    const urlObj = new URL(prod.url_sams);
                    const partes = urlObj.pathname.split('/').filter(p => p && !['p', 'produto'].includes(p.toLowerCase()));
                    const slug = partes[partes.length - 1];
                    
                    const res = await fetch(`https://www.samsclub.com.br/api/catalog_system/pub/products/search/${slug}`);
                    const data = res.ok ? await res.json() : [];
                    
                    if (data && data.length > 0) {
                        const oferta = data[0].items[0].sellers[0].commertialOffer;
                        relatorio.resultados.push({ 
                            seu_item: prod.nome_comum, 
                            estrategia: "LINK EXATO 🎯", 
                            preco_site: oferta.Price, 
                            status: oferta.Price > 0 ? "ENCONTRADO" : "SEM ESTOQUE" 
                        });
                        encontrado = true;
                    }
                } catch (e) {
                    context.log("Erro no link:", e.message);
                }
            }

            // 2. TENTATIVA BUSCA (Fallback com Validação de Nome)
            if (!encontrado) {
                try {
                    const termo = encodeURIComponent(
                        limparTermoBusca(prod.nome_comum).split(' ').slice(0, 2).join(' ')
                    );

                    const res = await fetch(
                        `https://www.samsclub.com.br/api/catalog_system/pub/products/search/${termo}?_from=0&_to=10`
                    );

                    const data = res.ok ? await res.json() : [];
                    
                    if (data && data.length > 0) {
                        // VALIDAÇÃO: Só aceita se o nome do produto contiver pelo menos uma parte do nome que você cadastrou
                        const termoParaValidar = prod.nome_comum.toUpperCase();

                        const melhorMatch = data.find(item =>
                            item.productName.toUpperCase().includes(termoParaValidar.split(' ')[0]) &&
                            item.productName.toUpperCase().includes(termoParaValidar.split(' ')[1] || "")
                        );

                        if (melhorProduto) {
                            const oferta = melhorProduto.items[0].sellers[0].commertialOffer;

                            relatorio.resultados.push({
                                seu_item: prod.nome_comum,
                                estrategia: "BUSCA VALIDADA ✅",
                                preco_site: oferta.Price,
                                status: "ENCONTRADO"
                            });
                        } else {
                            relatorio.resultados.push({
                                seu_item: prod.nome_comum,
                                status: "NÃO ENCONTRADO (Nome não coincidiu)"
                            });
                        }
                    } else {
                        relatorio.resultados.push({
                            seu_item: prod.nome_comum,
                            status: "NÃO ENCONTRADO"
                        });
                    }
                } catch (e) {
                    relatorio.resultados.push({
                        seu_item: prod.nome_comum,
                        erro: e.message
                    });
                }
            }
        }

        context.res = {
            status: 200,
            body: relatorio
        };

    } catch (e) {
        context.res = {
            status: 500,
            body: {
                erro: e.message
            }
        };
    } finally {
        if (client) await client.close();
    }
};