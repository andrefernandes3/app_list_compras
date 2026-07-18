const { MongoClient } = require('mongodb');

// ============================================================================
// CONFIGURAÇÕES
// ============================================================================
const CEP_PADRAO = process.env.CEP_PADRAO || '06093085'; // CEP fixo
const TIMEOUT_MS = 15000; // 15 segundos

// ============================================================================
// 1. FUNÇÃO: OBTER REGION_ID DINAMICAMENTE PELO CEP
// ============================================================================
async function obterRegionIdPorCep(cep) {
    try {
        const url = `https://www.atacadao.com.br/api/checkout/pub/regions?country=BRA&postalCode=${cep}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) return null;
        const data = await response.json();
        // A resposta geralmente é um array de regiões; pega a primeira com estoque?
        // Normalmente o primeiro é o mais relevante.
        if (Array.isArray(data) && data.length > 0) {
            return data[0].id || null;
        }
        return null;
    } catch (error) {
        console.warn(`Falha ao obter regionId para CEP ${cep}:`, error.message);
        return null;
    }
}

// ============================================================================
// 2. FUNÇÃO AUXILIAR DE REQUISIÇÃO COM FETCH + TIMEOUT + RETRY
// ============================================================================
async function buscarDadosVtex(url, tentativas = 2) {
    for (let i = 0; i < tentativas; i++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json'
                }
            });
            clearTimeout(timeout);
            if (response.status >= 300 && response.status < 400) {
                // Seguir redirect
                const location = response.headers.get('location');
                if (location) {
                    const novaUrl = location.startsWith('/') ? `https://www.atacadao.com.br${location}` : location;
                    return buscarDadosVtex(novaUrl, 1); // chama recursivo sem contar como tentativa extra
                }
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            return data;
        } catch (err) {
            console.warn(`Tentativa ${i+1} falhou para ${url}:`, err.message);
            if (i === tentativas - 1) return null;
            // Aguarda 1s antes de nova tentativa
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return null;
}

// ============================================================================
// 3. FUNÇÃO: OBTER ÚLTIMO PREÇO VÁLIDO DO BANCO (WEB)
// ============================================================================
async function obterUltimoPrecoValido(db, nomeProduto, nomeLoja) {
    const ultimoRegistro = await db.collection('historico_precos_web')
        .find({ nome: nomeProduto, loja: nomeLoja, preco: { $gt: 0 } })
        .sort({ data_verificacao: -1 })
        .limit(1)
        .toArray();
    return ultimoRegistro.length > 0 ? ultimoRegistro[0].preco : Infinity;
}

// ============================================================================
// 4. FUNÇÃO PRINCIPAL – AZURE FUNCTION
// ============================================================================
module.exports = async function (context, req) {
    const configs = [
        { 
            id: 'ATACADAO', 
            nome: "Atacadão", 
            host: 'https://www.atacadao.com.br', 
            scList: [1, 2] // tenta ambos os canais
        }
    ];

    let client = null;
    let relatorio = [];

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        const dicionarioCol = db.collection('dicionario_produtos');
        const alertasCol = db.collection('alertas_preco');

        // Obtém regionId dinamicamente
        let regionId = await obterRegionIdPorCep(CEP_PADRAO);
        if (!regionId) {
            context.log.warn('Não foi possível obter regionId, usando fallback fixo (pode não funcionar).');
            regionId = 'v2.8CB7CC2FFB5F56CD19FB23952C3277A6'; // fallback
        } else {
            context.log(`RegionId obtido: ${regionId}`);
        }

        // Busca produtos ativos com EAN
        const monitorados = await dicionarioCol.find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();
        if (monitorados.length === 0) {
            context.res = { 
                status: 200, 
                body: { aviso: "Nenhum produto válido para monitorar." } 
            };
            return;
        }

        for (const prod of monitorados) {
            const resultadosProduto = [];

            for (const lojaConfig of configs) {
                let encontrado = false;
                let precoAtual = 0, nomeLojaOrigem = "", linkCompra = "";

                // Tenta cada salesChannel
                for (const sc of lojaConfig.scList) {
                    if (encontrado) break;

                    let urlEan = `${lojaConfig.host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${prod.ean}&sc=${sc}`;
                    if (regionId) urlEan += `&regionId=${regionId}`;
                    urlEan += `&_=${Date.now()}`;

                    context.log(`Buscando EAN ${prod.ean} no canal ${sc}...`);
                    const data = await buscarDadosVtex(urlEan);

                    if (data && Array.isArray(data) && data.length > 0) {
                        // Percorre todos os items e sellers
                        for (const item of data) {
                            if (encontrado) break;
                            if (!item.items || !Array.isArray(item.items)) continue;
                            for (const itemDetail of item.items) {
                                if (encontrado) break;
                                if (!itemDetail.sellers) continue;
                                for (const seller of itemDetail.sellers) {
                                    const offer = seller.commertialOffer;
                                    if (offer && offer.Price > 0) {
                                        precoAtual = offer.Price;
                                        nomeLojaOrigem = seller.sellerName || lojaConfig.nome;
                                        linkCompra = item.link || '';
                                        encontrado = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    // Se encontrou, sai do loop de sc
                    if (encontrado) break;
                }

                // Se não encontrou preço, tenta buscar sem sc (às vezes funciona)
                if (!encontrado) {
                    let urlEan = `${lojaConfig.host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${prod.ean}`;
                    if (regionId) urlEan += `&regionId=${regionId}`;
                    urlEan += `&_=${Date.now()}`;
                    context.log(`Tentando sem sc para EAN ${prod.ean}...`);
                    const data = await buscarDadosVtex(urlEan);
                    if (data && Array.isArray(data) && data.length > 0) {
                        for (const item of data) {
                            if (encontrado) break;
                            if (!item.items) continue;
                            for (const itemDetail of item.items) {
                                if (encontrado) break;
                                if (!itemDetail.sellers) continue;
                                for (const seller of itemDetail.sellers) {
                                    const offer = seller.commertialOffer;
                                    if (offer && offer.Price > 0) {
                                        precoAtual = offer.Price;
                                        nomeLojaOrigem = seller.sellerName || lojaConfig.nome;
                                        linkCompra = item.link || '';
                                        encontrado = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }

                // Monta resultado para este produto nesta loja
                let status, preco = precoAtual, origem = nomeLojaOrigem, link = linkCompra;
                if (!encontrado) {
                    status = "NÃO ENCONTRADO OU SEM ESTOQUE";
                    preco = 0;
                    origem = "N/A";
                    link = "";
                } else {
                    status = "ENCONTRADO";
                }

                // Obter último preço web e referência
                const ultimoPrecoWeb = await obterUltimoPrecoValido(db, prod.nome_comum, lojaConfig.nome);
                const precoReferencia = prod.preco_alvo || ultimoPrecoWeb;
                const temAlvo = precoReferencia !== Infinity;

                const resultado = {
                    produto: prod.nome_comum,
                    loja: lojaConfig.nome,
                    origem: origem,
                    status: status,
                    preco: preco,
                    referencia_usada: temAlvo ? precoReferencia : null,
                    ultimoPrecoWeb: ultimoPrecoWeb !== Infinity ? ultimoPrecoWeb : null,
                    link: link
                };
                resultadosProduto.push(resultado);
                relatorio.push(resultado);

                // Se encontrou e preço > 0, processa alertas e histórico
                if (encontrado && preco > 0) {
                    // Disparo de alerta se preço abaixo da referência
                    if (temAlvo && preco < precoReferencia) {
                        const jaExiste = await alertasCol.findOne({
                            produto_nome: prod.nome_comum,
                            loja: lojaConfig.nome,
                            preco_atual: preco,
                            status_notificacao: "pendente"
                        });
                        if (!jaExiste) {
                            await alertasCol.insertOne({
                                produto_nome: prod.nome_comum,
                                loja: lojaConfig.nome,
                                preco_historico: precoReferencia,
                                preco_atual: preco,
                                link_compra: link,
                                data_alerta: new Date(),
                                status_notificacao: "pendente"
                            });
                            context.log(`Alerta criado para ${prod.nome_comum} - R$ ${preco}`);
                        }
                    }

                    // Salva histórico se houve mudança (comparado com último preço web)
                    if (preco !== ultimoPrecoWeb) {
                        await db.collection('historico_precos_web').insertOne({
                            nome: prod.nome_comum,
                            ean: prod.ean,
                            loja: lojaConfig.nome,
                            origem: origem,
                            preco: preco,
                            data_verificacao: new Date()
                        });
                        context.log(`Histórico salvo para ${prod.nome_comum} - R$ ${preco}`);
                    }
                }
            }
        }

        // Resposta final
        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: relatorio
        };

    } catch (e) {
        context.log.error('Erro crítico:', e);
        context.res = {
            status: 500,
            body: { erro: "Erro Crítico: " + e.message }
        };
    } finally {
        if (client) await client.close();
    }
};