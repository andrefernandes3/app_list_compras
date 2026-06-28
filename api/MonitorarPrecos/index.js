const { MongoClient } = require('mongodb');
const fetch = require('node-fetch'); // Importação obrigatória para o Azure

// --- 1. FUNÇÕES AUXILIARES ---
async function obterMenorPrecoHistorico(db, nomeProduto) {
    const historico = await db.collection('historico_precos').find({ nome: nomeProduto }).toArray();
    if (historico.length === 0) return Infinity;
    return Math.min(...historico.map(h => h.preco));
}

function calcularScore(nomeBanco, nomeSite) {
    const palavrasBanco = nomeBanco.toUpperCase().split(' ').filter(p => p.length > 2);
    const textoSite = nomeSite.toUpperCase();
    return palavrasBanco.reduce((score, palavra) => textoSite.includes(palavra) ? score + 1 : score, 0);
}

// --- 2. FUNÇÃO PRINCIPAL DO ROBÔ ---
module.exports = async function (context, req) {
    const configs = {
        'SAMS': { host: 'https://www.samsclub.com.br', minScore: 1, nome: "Sam's Club" },
        'CARREFOUR': { host: 'https://www.carrefour.com.br', minScore: 2, nome: "Carrefour" },
        'ATACADAO': { host: 'https://www.atacadao.com.br', minScore: 1, nome: "Atacadão" }
    };

    let client = null;
    let relatorio = []; // Array que vai gerar o JSON no seu ecrã

    try {
        // Conexão com o Banco de Dados
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        const dicionarioCol = db.collection('dicionario_produtos');
        const alertasCol = db.collection('alertas_preco');
        
        // Pega apenas os produtos que estão com a chavinha ligada
        const monitorados = await dicionarioCol.find({ monitorar: true }).toArray();

        // Se não tiver nada marcado para monitorar, avisa no ecrã e para por aqui
        if (monitorados.length === 0) {
            context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { aviso: "Nenhum produto marcado para monitorar (monitorar: true)." } };
            return;
        }

        // Loop pelos produtos monitorados
        for (const prod of monitorados) {
            const precoReferencia = prod.preco_alvo || await obterMenorPrecoHistorico(db, prod.nome_comum);
            const temAlvo = precoReferencia !== Infinity;

            // Loop pelas lojas
            for (const [lojaId, cfg] of Object.entries(configs)) {
                let melhorMatch = null;
                let metodoUsado = "NENHUM";

                // --- TENTATIVA 1: BUSCA POR EAN ---
                if (prod.ean) {
                    try {
                        const urlEan = `${cfg.host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${prod.ean}`;
                        const resEan = await fetch(urlEan, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                        const textoEan = await resEan.text(); // Usa texto para não dar erro se o JSON vier quebrado
                        const dataEan = JSON.parse(textoEan);
                        
                        if (dataEan && dataEan.length > 0) {
                            melhorMatch = dataEan[0];
                            metodoUsado = "EAN";
                        }
                    } catch (e) { 
                        /* Se o EAN falhar, o robô engole o erro e vai para o Passo 2 */ 
                    }
                }

                // --- TENTATIVA 2: BUSCA POR TEXTO (CRAWLER) ---
                if (!melhorMatch) {
                    try {
                        const termo = encodeURIComponent(prod.nome_comum.split(' ').slice(0, 2).join(' ')); // Pega as 2 primeiras palavras
                        const urlTexto = `${cfg.host}/api/catalog_system/pub/products/search/${termo}?_from=0&_to=20`;
                        const resTexto = await fetch(urlTexto, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                        const dataTexto = resTexto.ok ? await resTexto.json() : [];

                        if (dataTexto && dataTexto.length > 0) {
                            let maiorScore = -1;
                            
                            dataTexto.forEach(item => {
                                // Regra do Carrefour: Ignorar vendedores terceiros
                                const ehVendidoPeloCarrefour = lojaId !== 'CARREFOUR' || 
                                    item.items[0].sellers.some(s => s.sellerName.toLowerCase().includes("carrefour"));
                                
                                if (!ehVendidoPeloCarrefour) return;

                                const score = calcularScore(prod.nome_comum, item.productName);
                                if (score > maiorScore) {
                                    maiorScore = score;
                                    melhorMatch = item;
                                }
                            });
                            
                            // Se achou, mas o score for muito baixo (ex: achou "Leite" mas queria "Leite Ninho"), ele descarta
                            if (maiorScore >= cfg.minScore) {
                                metodoUsado = `TEXTO (Score: ${maiorScore})`;
                            } else {
                                melhorMatch = null; // Reseta se não atingiu o mínimo
                            }
                        }
                    } catch (e) { 
                        // Erro de texto
                    }
                }

                // --- PROCESSAMENTO FINAL (GRAVAR ALERTA E GERAR RELATÓRIO) ---
                if (melhorMatch) {
                    const oferta = melhorMatch.items[0].sellers[0].commertialOffer;
                    const precoAtual = oferta.Price;
                    
                    // Adiciona na ecrã
                    relatorio.push({
                        produto: prod.nome_comum,
                        loja: cfg.nome,
                        status: "ENCONTRADO",
                        metodo: metodoUsado,
                        preco: precoAtual,
                        link: melhorMatch.link
                    });

                    // Verifica se está barato e salva no banco (se tiver preço alvo definido)
                    if (temAlvo && precoAtual < precoReferencia && precoAtual > 0) {
                        const jaExiste = await alertasCol.findOne({
                            produto_nome: prod.nome_comum, loja: cfg.nome, preco_atual: precoAtual, status_notificacao: "pendente"
                        });
                        
                        if (!jaExiste) {
                            await alertasCol.insertOne({
                                produto_nome: prod.nome_comum, 
                                loja: cfg.nome, 
                                preco_historico: precoReferencia,
                                preco_atual: precoAtual, 
                                link_compra: melhorMatch.link, 
                                data_alerta: new Date(), 
                                status_notificacao: "pendente"
                            });
                        }
                    }
                } else {
                    // Se não achou de jeito nenhum, avisa na ecrã
                    relatorio.push({ 
                        produto: prod.nome_comum, 
                        loja: cfg.nome, 
                        status: "NAO_ENCONTRADO" 
                    });
                }
            }
        }

        // --- RESPOSTA FINAL DO SERVIDOR ---
        context.res = { 
            status: 200, 
            headers: { "Content-Type": "application/json" },
            body: relatorio 
        };
        
    } catch (e) {
        context.res = { status: 500, headers: { "Content-Type": "application/json" }, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};