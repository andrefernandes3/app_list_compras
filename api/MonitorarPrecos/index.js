const { MongoClient } = require('mongodb');

const client = new MongoClient(process.env.MONGODB_URI);

module.exports = async function (context, myTimer) {
    context.log('🤖 Crawler iniciado: Monitorando ofertas do Sam\'s Club...');

    try {
        await client.connect();
        const db = client.db('app_list_compras');

        // 1. Busca os produtos do dicionário marcados com o sininho ativo (monitorar: true)
        const produtosParaMonitorar = await db.collection('dicionario').find({ monitorar: true }).toArray();

        if (produtosParaMonitorar.length === 0) {
            context.log('Nenhum produto marcado para monitoramento hoje.');
            return;
        }

        for (const produto of produtosParaMonitorar) {
            const nomeBusca = encodeURIComponent(produto.nome_comum);
            
            // URL da API interna de busca do Sam's Club
            const urlSams = `https://www.samsclub.com.br/api/v1/products/search?term=${nomeBusca}`;
            
            try {
                // Faz o fetch simulando o navegador e injetando cookies/headers se necessário
                const response = await fetch(urlSams, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
                        'Accept': 'application/json'
                    }
                });

                if (!response.ok) continue;
                
                const data = await response.json();
                
                // Pega o primeiro item retornado no resultado da busca deles
                const produtoEncontrado = data.products?.[0];
                if (!produtoEncontrado) continue;

                // Captura o preço atual de venda no e-commerce
                const precoAtualSams = produtoEncontrado.price?.value || null;
                const linkProduto = produtoEncontrado.link || '';

                // 2. Se achou o preço e ele for MENOR que o menor histórico registrado no seu banco
                if (precoAtualSams && precoAtualSams < (produto.menor_preco_historico || Infinity)) {
                    context.log(`🔥 PREÇO BAIXO ENCONTRADO: ${produto.nome_comum} no Sam's Club por R$ ${precoAtualSams}`);

                    // 3. Grava ou atualiza o alerta na coleção 'alertas_preco'
                    await db.collection('alertas_preco').updateOne(
                        { produto_id: produto._id },
                        {
                            $set: {
                                nome: produto.nome_comum,
                                preco_antigo: produto.menor_preco_historico,
                                preco_novo: precoAtualSams,
                                loja: "SAMS CLUB",
                                link: `https://www.samsclub.com.br${linkProduto}`,
                                data: new Date()
                            }
                        },
                        { upsert: true }
                    );
                }
            } catch (err) {
                context.log(`Erro ao consultar Sam's Club para o item [${produto.nome_comum}]:`, err.message);
            }
        }
    } catch (error) {
        context.log.error('Erro fatal no ciclo do monitor de preços:', error);
    } finally {
        await client.close();
    }
};