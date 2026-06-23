const { MongoClient } = require('mongodb');

const client = new MongoClient(process.env.MONGODB_URI);

module.exports = async function (context, req) {
    context.log('🔮 Forçando execução manual do Crawler Sam\'s Club...');
    
    let resultados = [];

    try {
        await client.connect();
        const db = client.db('app_list_compras');

        // 1. Busca os produtos que você ativou o sininho 🔔
        const produtosParaMonitorar = await db.collection('dicionario').find({ monitorar: true }).toArray();

        if (produtosParaMonitorar.length === 0) {
            return context.res = {
                status: 200,
                body: { mensagem: "Nenhum produto está com o sininho ativado no Dicionário ainda! Ative um para testar." }
            };
        }

        for (const produto of produtosParaMonitorar) {
            const nomeBusca = encodeURIComponent(produto.nome_comum);
            const urlSams = `https://www.samsclub.com.br/api/v1/products/search?term=${nomeBusca}`;
            
            try {
                const response = await fetch(urlSams, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json'
                    }
                });

                if (!response.ok) {
                    resultados.push({ produto: produto.nome_comum, status: `Erro na API do Sam's: ${response.status}` });
                    continue;
                }
                
                const data = await response.json();
                const produtoEncontrado = data.products?.[0];
                
                if (!produtoEncontrado) {
                    resultados.push({ produto: produto.nome_comum, status: "Não encontrado no e-commerce do Sam's" });
                    continue;
                }

                const precoAtualSams = produtoEncontrado.price?.value || null;
                const linkProduto = produtoEncontrado.link || '';
                const menorHistorico = produto.menor_preco_historico || Infinity;

                // 2. Compara com o banco
                let mudou = false;
                if (precoAtualSams && precoAtualSams < menorHistorico) {
                    mudou = true;
                    // Grava o alerta na coleção para o app consumir
                    await db.collection('alertas_preco').updateOne(
                        { produto_id: produto._id },
                        {
                            $set: {
                                nome: produto.nome_comum,
                                preco_antigo: menorHistorico,
                                preco_novo: precoAtualSams,
                                loja: "SAMS CLUB",
                                link: `https://www.samsclub.com.br${linkProduto}`,
                                data: new Date()
                            }
                        },
                        { upsert: true }
                    );
                }

                resultados.push({
                    produto: produto.nome_comum,
                    preco_no_site: precoAtualSams,
                    seu_menor_historico: menorHistorico,
                    gerou_alerta_preco_baixo: mudou
                });

            } catch (err) {
                resultados.push({ produto: produto.nome_comum, erro: err.message });
            }
        }

        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: { 
                sucesso: true, 
                mensagem: "Crawler executado com sucesso!", 
                relatorio: resultados 
            }
        };

    } catch (error) {
        context.res = {
            status: 500,
            body: { erro: "Erro fatal no banco de dados", detalhes: error.message }
        };
    } finally {
        await client.close();
    }
};