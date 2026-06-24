const { MongoClient } = require("mongodb");
const axios = require("axios");

const uri = process.env.MONGODB_URI;

module.exports = async function (context, req) {
    context.log("Iniciando monitoramento de preços...");
    let client;

    try {
        client = new MongoClient(uri);
        await client.connect();
        const db = client.db("app_compras");
        const dicionarioCol = db.collection("dicionario_produtos");
        const alertasCol = db.collection("alertas_preco");

        // Busca apenas itens que você marcou para monitorar
        const produtos = await dicionarioCol.find({ monitorar: true }).toArray();
        let totalAlertas = 0;

        for (const produto of produtos) {
            // Se não tiver ID, não tem como buscar no site, então pula
            if (!produto.ids_vinculados || produto.ids_vinculados.length === 0) continue;

            const menorPrecoHistorico = await obterMenorPrecoHistorico(db, produto.ids_vinculados);
            if (menorPrecoHistorico === Infinity) continue;

            // Aguarda 2 segundos entre cada produto para não ser bloqueado
            await new Promise(r => setTimeout(r, 2000));

            // Tenta buscar nas 3 lojas sequencialmente
            const lojas = [
                { nome: "Sam's Club", func: buscarPrecoSams },
                { nome: "Carrefour", func: buscarPrecoCarrefour },
                { nome: "Atacadão", func: buscarPrecoAtacadao }
            ];

            for (const lojaObj of lojas) {
                const resultado = await lojaObj.func(produto);
                if (resultado && resultado.precoAtual > 0) {
                    // Verifica se o preço atual é menor que o histórico
                    if (resultado.precoAtual < menorPrecoHistorico) {
                        const novoAlerta = {
                            produto_nome: produto.nome_comum,
                            loja: lojaObj.nome,
                            preco_historico: menorPrecoHistorico,
                            preco_atual: resultado.precoAtual,
                            link_compra: resultado.link,
                            data_alerta: new Date(),
                            status_notificacao: "pendente"
                        };
                        
                        await alertasCol.insertOne(novoAlerta);
                        context.log(`[ALERTA] ${produto.nome_comum} está barato no ${lojaObj.nome}!`);
                        totalAlertas++;
                    }
                }
            }
        }

        context.res = { status: 200, body: { message: "Monitoramento concluído.", total_alertas: totalAlertas } };
    } catch (error) {
        context.log.error("Erro no monitoramento:", error);
        context.res = { status: 500, body: { error: "Erro interno no sistema." } };
    } finally {
        if (client) await client.close();
    }
};

// --- Funções de Apoio (Ficam no mesmo arquivo para você não se perder) ---

async function obterMenorPrecoHistorico(db, ids) {
    const notas = await db.collection("notas_fiscais").find({ "itens.id_interno": { $in: ids } }).toArray();
    let min = Infinity;
    for (const n of notas) {
        for (const i of n.itens) {
            if (ids.includes(i.id_interno) && i.preco_unitario < min) min = i.preco_unitario;
        }
    }
    return min;
}

async function buscarPrecoSams(p) {
    try {
        const res = await axios.get(`https://www.samsclub.com.br/api/catalog_system/pub/products/search?fq=productId:${p.ids_vinculados[0]}`);
        return { precoAtual: res.data[0].items[0].sellers[0].commertialOffer.Price, link: res.data[0].link };
    } catch { return null; }
}

async function buscarPrecoCarrefour(p) {
    try {
        const res = await axios.get(`https://carrefourbr.vtexcommercestable.com.br/api/catalog_system/pub/products/search?fq=productId:${p.ids_vinculados[0]}`);
        return { precoAtual: res.data[0].items[0].sellers[0].commertialOffer.Price, link: res.data[0].link };
    } catch { return null; }
}

async function buscarPrecoAtacadao(p) {
    try {
        const res = await axios.get(`https://www.atacadao.com.br/api/catalog_system/pub/products/search?fq=productId:${p.ids_vinculados[0]}`);
        return { precoAtual: res.data[0].items[0].sellers[0].commertialOffer.Price, link: res.data[0].link };
    } catch { return null; }
}