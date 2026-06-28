const { MongoClient } = require('mongodb');

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
                    
                    // Dispara a requisição padrão, sem forçar CEP, para não ser bloqueado
                    const res = await fetch(urlEan, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                    const textoRes = await res.text(); 
                    
                    let data = null;
                    try {
                        data = JSON.parse(textoRes);
                    } catch (e) {
                        data = null; 
                    }

                    if (data && data.length > 0) {
                        const item = data[0];
                        let precoAtual = 0;
                        let linkCompra = item.link;

                        // INTELIGÊNCIA: Procura o primeiro vendedor que tenha preço maior que zero
                        for (const seller of item.items[0].sellers) {
                            if (seller.commertialOffer.Price > 0) {
                                precoAtual = seller.commertialOffer.Price;
                                break; // Achou preço real, para de procurar
                            }
                        }

                        if (precoAtual > 0) {
                            relatorio.push({
                                produto: prod.nome_comum,
                                loja: lojaConfig.nome,
                                status: "ENCONTRADO",
                                preco: precoAtual
                            });

                            // Salva o alerta se estiver barato
                            if (temAlvo && precoAtual < precoReferencia) {
                                const jaExiste = await alertasCol.findOne({
                                    produto_nome: prod.nome_comum, loja: lojaConfig.nome, preco_atual: precoAtual, status_notificacao: "pendente"
                                });
                                
                                if (!jaExiste) {
                                    await alertasCol.insertOne({
                                        produto_nome: prod.nome_comum, 
                                        loja: lojaConfig.nome, 
                                        preco_historico: precoReferencia,
                                        preco_atual: precoAtual, 
                                        link_compra: linkCompra, 
                                        data_alerta: new Date(), 
                                        status_notificacao: "pendente"
                                    });
                                }
                            }
                        } else {
                            // Achou o produto no catálogo geral, mas todos os estoques estão zerados
                            relatorio.push({ 
                                produto: prod.nome_comum, 
                                loja: lojaConfig.nome, 
                                status: "SEM ESTOQUE (Preço 0,00)" 
                            });
                        }
                    } else {
                        // Não achou o EAN no site
                        relatorio.push({ produto: prod.nome_comum, loja: lojaConfig.nome, status: "NÃO ENCONTRADO NO CATÁLOGO" });
                    }
                } catch (err) {
                    relatorio.push({ produto: prod.nome_comum, loja: lojaConfig.nome, status: "ERRO DE CONEXÃO" });
                }
            }
        }

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