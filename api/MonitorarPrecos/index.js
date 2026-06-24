api/MonitorarPrecos/index.jsconst { MongoClient } = require("mongodb");
const axios = require("axios");

const uri = process.env.MONGODB_URI;
let dbClientPromise = null;

async function getDb() {
    if (!dbClientPromise) {
        const client = new MongoClient(uri);
        dbClientPromise = client.connect().then(c => c.db("app_compras"));
    }
    return dbClientPromise;
}

module.exports = async function (context, req) {
    context.log("Iniciando engine de monitoramento de preços completa...");

    try {
        const db = await getDb();
        const dicionarioCol = db.collection("dicionario_produtos");
        const alertasCol = db.collection("alertas_preco");

        const produtos = await dicionarioCol.find({}).toArray();
        let totalAlertas = 0;

        for (const produto of produtos) {
            if (!produto.ids_vinculados || produto.ids_vinculados.length === 0) continue;

            const menorPrecoHistorico = await obterMenorPrecoHistorico(db, produto.ids_vinculados);
            if (menorPrecoHistorico === Infinity) continue;

            const resultados = await Promise.allSettled([
                buscarPrecoSams(produto, context),
                buscarPrecoCarrefour(produto, context),
                buscarPrecoAtacadao(produto, context)
            ]);

            for (const resultado of resultados) {
                if (resultado.status === "fulfilled" && resultado.value) {
                    const { loja, precoAtual, link } = resultado.value;

                    if (precoAtual < menorPrecoHistorico) {
                        const novoAlerta = {
                            produto_nome: produto.nome_comum,
                            ids_vinculados: produto.ids_vinculados,
                            loja: loja,
                            preco_historico: menorPrecoHistorico,
                            preco_atual: precoAtual,
                            link_compra: link,
                            data_alerta: new Date(),
                            status_notificacao: "pendente"
                        };
                        
                        const insertResult = await alertasCol.insertOne(novoAlerta);
                        novoAlerta._id = insertResult.insertedId;
                        
                        context.log(`[ALERTA] ${produto.nome_comum} baixou para R$${precoAtual} no ${loja}`);
                        await enviarEmailAlerta(novoAlerta, db, context);
                        totalAlertas++;
                    }
                }
            }
        }

        context.res = {
            status: 200,
            body: { message: "Monitoramento executado com sucesso.", alertas_gerados: totalAlertas }
        };

    } catch (error) {
        context.log.error("Erro no monitoramento:", error);
        context.res = {
            status: 500,
            body: { error: "Erro interno na engine." }
        };
    }
};

async function obterMenorPrecoHistorico(db, idsVinculados) {
    const historicoCol = db.collection("notas_fiscais");
    const notas = await historicoCol.find({
        "itens.id_interno": { $in: idsVinculados }
    }).toArray();

    let menorPreco = Infinity;
    for (const nota of notas) {
        for (const item of nota.itens) {
            if (idsVinculados.includes(item.id_interno) && item.preco_unitario < menorPreco) {
                menorPreco = item.preco_unitario;
            }
        }
    }
    return menorPreco;
}

async function buscarPrecoSams(produto, context) {
    try {
        const urlSams = `https://www.samsclub.com.br/api/catalog_system/pub/products/search?fq=productId:${produto.ids_vinculados[0]}`;
        const response = await axios.get(urlSams, { timeout: 10000 });
        
        if (response.data && response.data.length > 0) {
            const item = response.data[0].items[0];
            const preco = item.sellers[0].commertialOffer.Price;
            return { loja: "Sam's Club", precoAtual: preco, link: response.data[0].link };
        }
    } catch (error) {
        context.log.warn(`[Sams] Falha ao buscar ${produto.nome_comum}`);
    }
    return null;
}

async function buscarPrecoCarrefour(produto, context) {
    try {
        const urlCarrefour = `https://carrefourbr.vtexcommercestable.com.br/api/catalog_system/pub/products/search?fq=productId:${produto.ids_vinculados[0]}`;
        const response = await axios.get(urlCarrefour, { timeout: 10000 });
        
        if (response.data && response.data.length > 0) {
            const item = response.data[0].items[0];
            const preco = item.sellers[0].commertialOffer.Price;
            return { loja: "Carrefour", precoAtual: preco, link: response.data[0].link };
        }
    } catch (error) {
        context.log.warn(`[Carrefour] Falha ao buscar ${produto.nome_comum}`);
    }
    return null;
}

async function buscarPrecoAtacadao(produto, context) {
    try {
        const urlAtacadao = `https://www.atacadao.com.br/api/catalog_system/pub/products/search?fq=productId:${produto.ids_vinculados[0]}`;
        const response = await axios.get(urlAtacadao, { timeout: 10000 });
        
        if (response.data && response.data.length > 0) {
            const item = response.data[0].items[0];
            const preco = item.sellers[0].commertialOffer.Price;
            return { loja: "Atacadão", precoAtual: preco, link: response.data[0].link };
        }
    } catch (error) {
        context.log.warn(`[Atacadao] Falha ao buscar ${produto.nome_comum}`);
    }
    return null;
}

async function enviarEmailAlerta(alerta, db, context) {
    try {
        /* LÓGICA DO NODEMAILER 
        const nodemailer = require("nodemailer");
        const transporter = nodemailer.createTransport({ ... });
        await transporter.sendMail({
            from: '"App Compras" <app@exemplo.com>',
            to: "seuemail@exemplo.com",
            subject: `🚨 Oferta: ${alerta.produto_nome}`,
            text: `R$${alerta.preco_atual} no ${alerta.loja}`
        });
        */
        await db.collection("alertas_preco").updateOne(
            { _id: alerta._id },
            { $set: { status_notificacao: "marcado_para_envio" } }
        );
    } catch (error) {
        context.log.error("Erro ao gerenciar notificação:", error);
    }
}