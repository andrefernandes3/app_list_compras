const { MongoClient } = require('mongodb');
const fetch = require('node-fetch');

// --- FUNÇÕES AUXILIARES ---
async function obterMenorPrecoHistorico(db, nomeProduto) {
    const historico = await db.collection('historico_precos').find({ nome: nomeProduto }).toArray();
    if (historico.length === 0) return Infinity;
    return Math.min(...historico.map(h => h.preco));
}

function construirTermoBusca(nome) { return nome.split(' ').slice(0, 3).join(' '); }

async function buscarProdutos(url, lojaId, termo) {
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        return await res.json();
    } catch (e) { return []; }
}

function filtrarMelhorMatch(prod, lista) {
    return lista.find(item => item.productName.toUpperCase().includes(prod.nome_comum.split(' ')[0]));
}

async function registrarLog(db, mensagem) {
    await db.collection('logs_robo').insertOne({ mensagem, data: new Date() });
    await db.collection('logs_robo').deleteMany({
        _id: { $nin: (await db.collection('logs_robo').find().sort({data:-1}).limit(50).toArray()).map(l => l._id) }
    });
}

// --- FUNÇÃO PRINCIPAL ---
module.exports = async function (context, req) {
    const configs = [
        { id: 'SAMS', nome: "Sam's Club", host: 'https://www.samsclub.com.br' },
        { id: 'CARREFOUR', nome: "Carrefour", host: 'https://www.carrefour.com.br' },
        { id: 'ATACADAO', nome: "Atacadão", host: 'https://www.atacadao.com.br' }
    ];

    let client = null;
    let relatorio = []; // <--- Este array vai montar o seu JSON na tela

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        const dicionarioCol = db.collection('dicionario_produtos');
        const alertasCol = db.collection('alertas_preco');
        
        const monitorados = await dicionarioCol.find({ monitorar: true }).toArray();

        for (const prod of monitorados) {
            const precoRef = prod.preco_alvo || await obterMenorPrecoHistorico(db, prod.nome_comum);
            if (precoRef === Infinity) continue;

            for (const lojaConfig of configs) {
                let matchEncontrado = null;

                // 1. EAN
                if (prod.ean) {
                    const urlEan = `${lojaConfig.host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${prod.ean}`;
                    try {
                        const res = await fetch(urlEan, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                        const data = await res.json();
                        if (data && data.length > 0) matchEncontrado = data[0];
                    } catch (e) { }
                }

                // 2. Texto
                if (!matchEncontrado) {
                    const termo = construirTermoBusca(prod.nome_comum);
                    const urlTexto = `${lojaConfig.host}/api/catalog_system/pub/products/search/${encodeURIComponent(termo)}?_from=0&_to=5`;
                    const dataTexto = await buscarProdutos(urlTexto, lojaConfig.id, termo);
                    if (dataTexto && dataTexto.length > 0) matchEncontrado = filtrarMelhorMatch(prod, dataTexto);
                }

                // 3. Resultado
                if (matchEncontrado) {
                    const precoAtual = matchEncontrado.items[0].sellers[0].commertialOffer.Price;
                    relatorio.push({ produto: prod.nome_comum, loja: lojaConfig.nome, status: "MATCH_PERFEITO", preco: precoAtual });
                    
                    if (precoAtual < precoRef) {
                        const jaExiste = await alertasCol.findOne({ produto_nome: prod.nome_comum, loja: lojaConfig.nome, preco_atual: precoAtual, status_notificacao: "pendente" });
                        if (!jaExiste) {
                            await alertasCol.insertOne({ produto_nome: prod.nome_comum, loja: lojaConfig.nome, preco_historico: precoRef, preco_atual: precoAtual, link_compra: matchEncontrado.link, data_alerta: new Date(), status_notificacao: "pendente" });
                        }
                    }
                } else {
                    relatorio.push({ produto: prod.nome_comum, loja: lojaConfig.nome, status: "NAO_ENCONTRADO" });
                }
            }
        }

        context.res = { 
            status: 200, 
            headers: { "Content-Type": "application/json" },
            body: relatorio 
        };
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};