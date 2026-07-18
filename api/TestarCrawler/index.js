const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// CONFIGURAÇÕES GLOBAIS
// ============================================================================
const CEP_PADRAO = process.env.CEP_PADRAO || '06093085';
const TIMEOUT_MS = 10000;
const MAX_RETRIES = 3;

const agent = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 3000 });

// ... (MANTENHA AQUI AS MESMAS FUNÇÕES DE ANTES: obterCookiesSams, buscarDadosComRetry, 
// simularCarrinhoLote, extrairInfoProduto, extrairPrecoDireto, obterRegionIdPorLoja, 
// buscarProdutoNaLoja, obterUltimoPrecoValido) ...

// ============================================================================
// FUNÇÃO PRINCIPAL (AGORA COMO TIMER TRIGGER)
// ============================================================================

// Note que mudamos 'req' para 'meuTimer'
module.exports = async function (context, meuTimer) {
    context.log('🤖 Robô Acordou! Iniciando varredura agendada em:', new Date().toISOString());

    const configs = [
        {
            id: 'ATACADAO', nome: "Atacadão", host: 'https://www.atacadao.com.br',
            scList: [1, 2, 3], sellers: ['atacadaobr637', 'atacadaobr634', 'atacadaobr649', 'atacadaobr680', 'atacadaobr697', 'atacadaobr698', 'atacadaobr938', 'atacadaobr939'],
            regionIdFixo: null, binding: null, usarCookies: false
        },
        {
            id: 'SAMS', nome: "Sam's Club", host: 'https://www.samsclub.com.br',
            scList: [1, 2, 3], sellers: ['samsclub6058', 'samsclub6546', '1','2','3','4','5','6','7','8','9','10', 'samsclub', 'samsclubbr'],
            regionIdFixo: 'IlUxY2pjMkZ0YzJOc2RXSTJNRFU0TzNOaGJYTmpiSFZpTmpVME5nPT0i', binding: 'samsclub.myvtex.com/', usarCookies: true
        }
    ];

    let client = null;
    let totalSucessos = 0;

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        
        const cookiesMap = {};
        for (const cfg of configs) {
            cookiesMap[cfg.id] = cfg.usarCookies ? await obterCookiesSams(cfg.host) : {};
        }

        const regionIds = {};
        for (const cfg of configs) {
            regionIds[cfg.id] = await obterRegionIdPorLoja(cfg, CEP_PADRAO, cookiesMap[cfg.id]);
        }

        const monitorados = await db.collection('dicionario_produtos').find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();
        if (monitorados.length === 0) {
            context.log.info("Nenhum produto válido para monitorar hoje.");
            return; // Sai silenciosamente
        }

        context.log(`Iniciando fila indiana para ${monitorados.length} produtos...`);

        // Loop Sequencial Seguro (Fila Indiana)
        for (const prod of monitorados) {
            for (const cfg of configs) {
                try {
                    let encontrado = false;
                    const cookies = cookiesMap[cfg.id];
                    const regionId = regionIds[cfg.id];

                    const sellerPreferido = prod.seller_preferido || null;
                    let sellersToTry = cfg.sellers;
                    if (sellerPreferido && cfg.sellers.includes(sellerPreferido)) {
                        sellersToTry = [sellerPreferido, ...cfg.sellers.filter(s => s !== sellerPreferido)];
                    }

                    for (const sc of cfg.scList) {
                        const resultado = await buscarProdutoNaLoja(cfg.host, regionId, sc, prod.ean, prod.nome_comum, sellersToTry, cookies, cfg.binding);
                        
                        if (resultado) {
                            if (resultado.seller && resultado.seller !== sellerPreferido) {
                                await db.collection('dicionario_produtos').updateOne({ _id: prod._id }, { $set: { seller_preferido: resultado.seller } });
                            }

                            const ultimoPrecoWeb = await obterUltimoPrecoValido(db, prod.nome_comum, cfg.nome);
                            const precoReferencia = prod.preco_alvo || ultimoPrecoWeb || Infinity;

                            // Cria alerta se estiver abaixo do alvo
                            if (resultado.preco > 0 && precoReferencia !== Infinity && resultado.preco < precoReferencia) {
                                const jaExiste = await db.collection('alertas_preco').findOne({ produto_nome: prod.nome_comum, loja: cfg.nome, preco_atual: resultado.preco, status_notificacao: "pendente" });
                                if (!jaExiste) {
                                    await db.collection('alertas_preco').insertOne({
                                        produto_nome: prod.nome_comum, loja: cfg.nome, preco_historico: precoReferencia, preco_atual: resultado.preco,
                                        link_compra: resultado.link, data_alerta: new Date(), status_notificacao: "pendente"
                                    });
                                }
                            }

                            // Registra o histórico na web
                            if (ultimoPrecoWeb === Infinity || resultado.preco !== ultimoPrecoWeb) {
                                await db.collection('historico_precos_web').insertOne({
                                    nome: prod.nome_comum, ean: prod.ean, loja: cfg.nome, origem: resultado.nomeLojaOrigem || 'N/A',
                                    preco: resultado.preco, data_verificacao: new Date()
                                });
                            }
                            
                            encontrado = true;
                            totalSucessos++;
                            break; 
                        }
                    }

                } catch (erroLoja) {
                    context.log.warn(`Erro no produto ${prod.nome_comum} (Loja: ${cfg.nome}): ${erroLoja.message}`);
                }
                
                await new Promise(resolve => setTimeout(resolve, 300));
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        context.log(`🏁 Varredura concluída! Sucessos: ${totalSucessos}`);
        // NÃO TEM context.res AQUI. O Timer não devolve resposta de tela.

    } catch (e) {
        context.log.error('❌ Erro crítico no Crawler Agendado:', e);
    } finally {
        if (client) await client.close();
    }
};