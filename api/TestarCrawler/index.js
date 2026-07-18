module.exports = async function (context, req) {
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
    let relatorio = [];

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
            context.res = { status: 200, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        // ========================================================
        // FILA INDIANA (SEQUENCIAL): Um produto por vez, uma loja por vez
        // Isso elimina o "Backend call failure" por sobrecarga
        // ========================================================
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

                            const entry = {
                                produto: prod.nome_comum, loja: cfg.nome, origem: resultado.nomeLojaOrigem || 'N/A', status: 'ENCONTRADO',
                                preco: resultado.preco, referencia_usada: precoReferencia !== Infinity ? precoReferencia : null,
                                ultimoPrecoWeb: ultimoPrecoWeb !== Infinity ? ultimoPrecoWeb : null, link: resultado.link || ''
                            };

                            if (resultado.preco > 0 && precoReferencia !== Infinity && resultado.preco < precoReferencia) {
                                const jaExiste = await db.collection('alertas_preco').findOne({ produto_nome: prod.nome_comum, loja: cfg.nome, preco_atual: resultado.preco, status_notificacao: "pendente" });
                                if (!jaExiste) {
                                    await db.collection('alertas_preco').insertOne({
                                        produto_nome: prod.nome_comum, loja: cfg.nome, preco_historico: precoReferencia, preco_atual: resultado.preco,
                                        link_compra: resultado.link, data_alerta: new Date(), status_notificacao: "pendente"
                                    });
                                }
                            }

                            if (ultimoPrecoWeb === Infinity || resultado.preco !== ultimoPrecoWeb) {
                                await db.collection('historico_precos_web').insertOne({
                                    nome: prod.nome_comum, ean: prod.ean, loja: cfg.nome, origem: resultado.nomeLojaOrigem || 'N/A',
                                    preco: resultado.preco, data_verificacao: new Date()
                                });
                            }
                            encontrado = true;
                            relatorio.push(entry);
                            break; 
                        }
                    }

                    if (!encontrado) {
                        relatorio.push({ produto: prod.nome_comum, loja: cfg.nome, origem: 'N/A', status: 'NÃO ENCONTRADO', preco: 0 });
                    }

                } catch (erroLoja) {
                    context.log.warn(`⚠️ Erro isolado no produto ${prod.nome_comum} (Loja: ${cfg.nome}): ${erroLoja.message}`);
                }
                // Pequena pausa para manter o servidor estável
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }

        context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: relatorio };

    } catch (e) {
        context.log.error('Erro crítico no Crawler:', e);
        context.res = { status: 500, body: { erro: "Erro Crítico: " + e.message } };
    } finally {
        if (client) await client.close();
    }
};