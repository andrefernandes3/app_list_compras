const { MongoClient } = require('mongodb');

module.exports = async function (context, req) {
    let client = new MongoClient(process.env["MONGODB_URI"]);
    let relatorio = { loja: "CARREFOUR", resultados: [] };

    try {
        await client.connect();
        const col = client.db('app_compras').collection('dicionario_produtos');
        const monitorados = await col.find({ monitorar: true }).toArray();

        for (const prod of monitorados) {
            let resultado = { seu_item: prod.nome_comum, status: "NÃO ENCONTRADO" };
            let encontrado = null;

            // --- PLANO A: Busca por ID (Prioridade) ---
            if (prod.ids_vinculados && prod.ids_vinculados.length > 0) {
                for (let id of prod.ids_vinculados) {
                    encontrado = await buscarPorId(id);
                    if (encontrado) break;
                }
            }

            // --- PLANO B: Busca por Nome (Apenas se o ID falhou) ---
            if (!encontrado) {
                encontrado = await buscarPorNomeSeguro(prod.nome_comum);
            }

            // --- Montagem do resultado ---
            if (encontrado) {
                resultado = { 
                    seu_item: prod.nome_comum, 
                    item_oficial: encontrado.productName,
                    preco_site: encontrado.items[0].sellers[0].commertialOffer.Price,
                    link_site: encontrado.link,
                    status: "ENCONTRADO"
                };
            }
            relatorio.resultados.push(resultado);
        }
        context.res = { body: relatorio };
    } catch (e) { context.res = { status: 500, body: e.message }; }
    finally { await client.close(); }
};

// Função de Busca por ID
async function buscarPorId(id) {
    const url = `https://carrefourbr.vtexcommercestable.com.br/api/catalog_system/pub/products/search?fq=productId:${id}`;
    const res = await fetch(url);
    const data = await res.json();
    return (data.length > 0) ? data[0] : null;
}

// Função de Busca por Nome com FILTRO DE SEGURANÇA
async function buscarPorNomeSeguro(nome) {
    const termo = encodeURIComponent(nome);
    const url = `https://www.carrefour.com.br/api/catalog_system/pub/products/search?ft=${termo}&_from=0&_to=0`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await res.json();

    if (data.length > 0) {
        const item = data[0];
        // SEGURANÇA: Só aceita se o nome do site contiver pelo menos 2 palavras do seu nome original
        const palavrasChave = nome.toUpperCase().split(' ').slice(0, 2);
        const ehValido = palavrasChave.every(p => item.productName.toUpperCase().includes(p));
        
        return ehValido ? item : null;
    }
    return null;
}