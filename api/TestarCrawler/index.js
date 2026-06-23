const { MongoClient } = require('mongodb');

module.exports = async function (context, req) {
    // Diário de bordo para sabermos exatamente onde ele para
    let relatorio = { 
        passos: [], 
        resultados: [], 
        erro_fatal: null 
    };
    
    let client = null;

    try {
        relatorio.passos.push("1. Iniciou a Função TestarCrawler.");
        
        const uri = process.env["MONGODB_URI"];
        if (!uri) {
            throw new Error("MONGODB_URI não encontrado nas variáveis de ambiente!");
        }
        relatorio.passos.push("2. MONGODB_URI carregado com sucesso.");

        client = new MongoClient(uri);
        await client.connect();
        relatorio.passos.push("3. Conectado ao Servidor MongoDB.");

        const db = client.db('app_compras');
        const colecao = db.collection('dicionario_produtos');
        relatorio.passos.push("4. Acessou o banco 'app_compras' e a coleção 'dicionario_produtos'.");

        const total = await colecao.countDocuments();
        relatorio.passos.push(`5. Total de itens cadastrados no banco: ${total}`);

        const monitorados = await colecao.find({ monitorar: true }).toArray();
        relatorio.passos.push(`6. Itens com monitorar=true encontrados: ${monitorados.length}`);

        if (monitorados.length === 0) {
            relatorio.passos.push("7. PARADA: Nenhum item marcado para monitorar.");
            
            // Pega 1 item aleatório do banco para vermos como o "monitorar" está salvo nele
            const amostra = await colecao.findOne({});
            if (amostra) {
                relatorio.amostra_de_item_no_banco = {
                    nome: amostra.nome_comum,
                    status_monitorar: amostra.monitorar !== undefined ? amostra.monitorar : "Campo não existe"
                };
            }
            
            context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: relatorio };
            return;
        }

        relatorio.passos.push("7. Iniciando varredura no site do Sam's Club (VTEX API)...");

        // Loop nos produtos
        for (const prod of monitorados) {
            const termoBusca = encodeURIComponent(prod.nome_comum);
            // URL oficial da infraestrutura VTEX usada pelo Sam's Club Brasil e Carrefour
            const urlSams = `https://www.samsclub.com.br/api/catalog_system/pub/products/search/${termoBusca}`;
            
            try {
                const response = await fetch(urlSams, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json'
                    }
                });

                if (!response.ok) {
                    relatorio.resultados.push({ item: prod.nome_comum, status: `HTTP Bloqueado: ${response.status}` });
                    continue;
                }
                
                const data = await response.json();
                
                // O VTEX retorna um Array de produtos. Pegamos o primeiro.
                if (data && data.length > 0) {
                    // Navega pela árvore do VTEX para pegar o preço comercial
                    const precoCapturado = data[0].items[0].sellers[0].commertialOffer.Price;
                    const linkProduto = data[0].link || '';
                    
                    relatorio.resultados.push({ 
                        item: prod.nome_comum, 
                        preco_sams: precoCapturado, 
                        link: linkProduto 
                    });
                } else {
                    relatorio.resultados.push({ item: prod.nome_comum, status: "Não encontrado no catálogo do site" });
                }

            } catch (err) {
                relatorio.resultados.push({ item: prod.nome_comum, erro_no_fetch: err.message });
            }
        }

        context.res = { 
            status: 200, 
            headers: { "Content-Type": "application/json" }, 
            body: relatorio 
        };

    } catch (error) {
        relatorio.erro_fatal = error.message;
        // Mesmo se der erro grave, ele devolve o que conseguiu anotar
        context.res = { 
            status: 500, 
            headers: { "Content-Type": "application/json" }, 
            body: relatorio 
        };
    } finally {
        if (client) {
            await client.close();
        }
    }
};