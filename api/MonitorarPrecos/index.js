const { MongoClient } = require('mongodb');
const fetch = require('node-fetch');

// Função para pegar o menor preço histórico caso não tenha preço alvo
async function obterMenorPrecoHistorico(db, nomeProduto) {
    const historico = await db.collection('historico_precos').find({ nome: nomeProduto }).toArray();
    if (historico.length === 0) return Infinity;
    return Math.min(...historico.map(h => h.preco));
}

module.exports = async function (context, req) {
    const configs = [
        { id: 'SAMS', nome: "Sam's Club", host: 'https://www.samsclub.com.br' },
        { id: 'CARREFOUR', nome: "Carrefour", host: 'https://www.carrefour.com.br' },
        { id: 'ATACADAO', nome: "Atacadão", host: 'https://www.atacadao.com.br' }
    ];

    let client = null;
    let relatorio = []; // Array que vai mostrar o JSON no seu navegador

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        const dicionarioCol = db.collection('dicionario_produtos');
        const alertasCol = db.collection('alertas_preco');
        
        const monitorados = await dicionarioCol.find({ monitorar: true }).toArray();

        if (monitorados.length === 0) {
            context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { aviso: "Nenhum produto marcado para monitorar." } };
            return;
        }

        for (const prod of monitorados) {
            const precoReferencia = prod.preco_alvo || await obterMenorPrecoHistorico(db, prod.nome_comum);
            const temAlvo = precoReferencia !== Infinity;

            // Se o produto não tiver EAN cadastrado, pula e avisa no relatório
            if (!prod.ean) {
                relatorio.push({ produto: prod.nome_comum, status: "IGNORADO - SEM CÓDIGO EAN" });
                continue; 
            }

            for (const lojaConfig of configs) {
                try {
                    const urlEan = `${lojaConfig.host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${prod.ean}`;
                    
                    const res = await fetch(urlEan, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                    const textoRes = await res.text(); // Lê como texto para evitar a quebra do Carrefour
                    
                    let data = null;
                    try {
                        // Tenta converter para JSON. Se for erro do Carrefour, cai no catch abaixo silenciosamente
                        data = JSON.parse(textoRes);
                    } catch (e) {
                        data = null; 
                    }

                    if (data && data.length > 0) {
                        const item = data[0];
                        const precoAtual = item.items[0].sellers[0].commertialOffer.Price;

                        relatorio.push({
                            produto: prod.nome_comum,
                            loja: lojaConfig.nome,
                            status: "ENCONTRADO",
                            preco: precoAtual
                        });

                        // Verifica se está barato e salva no banco de alertas
                        if (temAlvo && precoAtual < precoReferencia && precoAtual > 0) {
                            const jaExiste = await alertasCol.findOne({
                                produto_nome: prod.nome_comum, loja: lojaConfig.nome, preco_atual: precoAtual, status_notificacao: "pendente"
                            });
                            
                            if (!jaExiste) {
                                await alertasCol.insertOne({
                                    produto_nome: prod.nome_comum, 
                                    loja: lojaConfig.nome, 
                                    preco_historico: precoReferencia,
                                    preco_atual: precoAtual, 
                                    link_compra: item.link, 
                                    data_alerta: new Date(), 
                                    status_notificacao: "pendente"
                                });
                            }
                        }
                    } else {
                        relatorio.push({ produto: prod.nome_comum, loja: lojaConfig.nome, status: "NÃO ENCONTRADO (Ou sem estoque)" });
                    }
                } catch (err) {
                    // Se der erro de internet ou timeout, não quebra o loop, só avisa no json
                    relatorio.push({ produto: prod.nome_comum, loja: lojaConfig.nome, status: "FALHA NA CONEXÃO" });
                }
            }
        }

        // Devolve o painel em JSON na tela
        context.res = { 
            status: 200, 
            headers: { "Content-Type": "application/json" },
            body: relatorio 
        };
        
    } catch (e) {
        context.res = { status: 500, headers: { "Content-Type": "application/json" }, body: { erro: "Erro Crítico: " + e.message } };
    } finally {
        if (client) await client.close();
    }
};