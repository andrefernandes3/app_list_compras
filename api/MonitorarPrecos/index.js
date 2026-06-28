const { MongoClient } = require('mongodb');

// --- FUNÇÕES AUXILIARES NECESSÁRIAS ---
async function obterMenorPrecoHistorico(db, nomeProduto) {
    const historico = await db.collection('historico_precos').find({ nome: nomeProduto }).toArray();
    if (historico.length === 0) return Infinity;
    return Math.min(...historico.map(h => h.preco));
}

function construirTermoBusca(nome) {
    return nome.split(' ').slice(0, 3).join(' '); // Pega as 3 primeiras palavras
}

async function buscarProdutos(url, lojaId, termo) {
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        return await res.json();
    } catch (e) { return []; }
}

function filtrarMelhorMatch(prod, lista) {
    return lista.find(item => item.productName.toUpperCase().includes(prod.nome_comum.split(' ')[0]));
}

// --- FUNÇÃO PRINCIPAL ---
module.exports = async function (context, req) {
    const configs = [
        { id: 'SAMS', nome: "Sam's Club", host: 'https://www.samsclub.com.br' },
        { id: 'CARREFOUR', nome: "Carrefour", host: 'https://www.carrefour.com.br' },
        { id: 'ATACADAO', nome: "Atacadão", host: 'https://www.atacadao.com.br' }
    ];

    let client = null;
    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        const dicionarioCol = db.collection('dicionario_produtos');
        const alertasCol = db.collection('alertas_preco');
        
        const monitorados = await dicionarioCol.find({ monitorar: true }).toArray();

        for (const prod of monitorados) {
            const precoReferencia = prod.preco_alvo || await obterMenorPrecoHistorico(db, prod.nome_comum);
            if (precoReferencia === Infinity) continue;

            for (const lojaConfig of configs) {
                try {
                    let matchEncontrado = null;

                    if (prod.ean) {
                        const urlEan = `${lojaConfig.host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${prod.ean}`;
                        const resEan = await fetch(urlEan, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                        const textoEan = await resEan.text();
                        try {
                            const dataEan = JSON.parse(textoEan);
                            if (dataEan && dataEan.length > 0) matchEncontrado = dataEan[0];
                        } catch (e) { }
                    }

                    if (!matchEncontrado) {
                        const termo = construirTermoBusca(prod.nome_comum);
                        const urlTexto = `${lojaConfig.host}/api/catalog_system/pub/products/search/${encodeURIComponent(termo)}?_from=0&_to=20`;
                        const dataTexto = await buscarProdutos(urlTexto, lojaConfig.id, termo);
                        if (dataTexto && dataTexto.length > 0) {
                            matchEncontrado = filtrarMelhorMatch(prod, dataTexto);
                        }
                    }

                    if (matchEncontrado) {
                        const precoAtual = matchEncontrado.items[0].sellers[0].commertialOffer.Price;
                        if (precoAtual < precoReferencia && precoAtual > 0) {
                            const jaExiste = await alertasCol.findOne({
                                produto_nome: prod.nome_comum, loja: lojaConfig.nome, preco_atual: precoAtual, status_notificacao: "pendente"
                            });
                            if (!jaExiste) {
                                await alertasCol.insertOne({
                                    produto_nome: prod.nome_comum, loja: lojaConfig.nome, preco_historico: precoReferencia,
                                    preco_atual: precoAtual, link_compra: matchEncontrado.link, data_alerta: new Date(), status_notificacao: "pendente"
                                });
                            }
                        }
                    }
                } catch (e) { }
            }
        }
        context.res = { status: 200, body: "Monitoramento Completo com EAN e Fallback." };
    } catch (e) {
        context.res = { status: 500, body: e.message };
    } finally {
        if (client) await client.close();
    }
};