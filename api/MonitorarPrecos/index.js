const { MongoClient } = require('mongodb');

const client = new MongoClient(process.env.MONGODB_URI);

module.exports = async function (context, req) {
    context.log('🤖 Crawler HTTP iniciado: Monitorando ofertas do Sam\'s Club...');

    try {
        await client.connect();
        const db = client.db('app_compras');

        const produtosParaMonitorar = await db.collection('dicionario_produtos').find({ monitorar: true }).toArray();

        if (produtosParaMonitorar.length === 0) {
            context.res = { status: 200, body: { mensagem: "Nenhum produto monitorado." } };
            return;
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

                if (!response.ok) continue;
                const data = await response.json();
                const produtoEncontrado = data.products?.[0];
                if (!produtoEncontrado) continue;

                const precoAtualSams = produtoEncontrado.price?.value || null;
                const linkProduto = produtoEncontrado.link || '';

                if (precoAtualSams && precoAtualSams < (produto.menor_preco_historico || Infinity)) {
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
                context.log(`Erro no item [${produto.nome_comum}]:`, err.message);
            }
        }

        context.res = {
            status: 200,
            body: { sucesso: true, mensagem: "Varredura concluída com sucesso!" }
        };

    } catch (error) {
        context.res = { status: 500, body: { erro: error.message } };
    } finally {
        await client.close();
    }
};