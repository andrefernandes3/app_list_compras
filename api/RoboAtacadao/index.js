const https = require('https');
const { MongoClient } = require('mongodb');

// ============================================================================
// CONFIGURAÇÕES
// ============================================================================
const CEP_PADRAO = process.env.CEP_PADRAO || '06093085'; // sem hífen
const TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

// ============================================================================
// 1. FUNÇÃO: OBTER REGIONID DINAMICAMENTE A PARTIR DO CEP
// ============================================================================
let regionIdCache = { value: null, timestamp: 0 };

async function obterRegionId(cep) {
    const agora = Date.now();
    if (regionIdCache.value && (agora - regionIdCache.timestamp) < 3600000) {
        return regionIdCache.value; // cache de 1 hora
    }

    const url = `https://www.atacadao.com.br/api/checkout/pub/regions?country=BRA&postalCode=${cep}`;
    try {
        const data = await buscarDadosComRetry(url);
        if (data && data.length > 0) {
            const region = data.find(r => r.id && r.id.startsWith('v2.')); // prefere os v2
            const id = region ? region.id : data[0].id;
            if (id) {
                regionIdCache = { value: id, timestamp: agora };
                return id;
            }
        }
    } catch (e) {
        console.warn('Falha ao obter regionId, usando fallback fixo.', e.message);
    }
    // Fallback: regionId fixo que você já tinha
    return 'v2.8CB7CC2FFB5F56CD19FB23952C3277A6';
}

// ============================================================================
// 2. FUNÇÃO: REQUISIÇÃO COM RETRY E TIMEOUT (USANDO HTTPS)
// ============================================================================
function buscarDadosComRetry(url, tentativa = 1) {
    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            },
            timeout: TIMEOUT_MS
        };

        const req = https.request(options, (res) => {
            // Redirecionamento
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let novaUrl = res.headers.location;
                if (novaUrl.startsWith('/')) novaUrl = `https://${urlObj.hostname}${novaUrl}`;
                return resolve(buscarDadosComRetry(novaUrl, tentativa));
            }
            if (res.statusCode !== 200) {
                return resolve(null);
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    resolve(null);
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            if (tentativa < MAX_RETRIES) {
                console.warn(`Timeout na tentativa ${tentativa}, tentando novamente...`);
                resolve(buscarDadosComRetry(url, tentativa + 1));
            } else {
                resolve(null);
            }
        });

        req.on('error', (err) => {
            if (tentativa < MAX_RETRIES) {
                console.warn(`Erro na tentativa ${tentativa}: ${err.message}, tentando novamente...`);
                resolve(buscarDadosComRetry(url, tentativa + 1));
            } else {
                resolve(null);
            }
        });

        req.end();
    });
}

// ============================================================================
// 3. FUNÇÃO: OBTER ÚLTIMO PREÇO VÁLIDO DA WEB (para comparação)
// ============================================================================
async function obterUltimoPrecoValido(db, nomeProduto, nomeLoja) {
    const ultimo = await db.collection('historico_precos_web')
        .find({ nome: nomeProduto, loja: nomeLoja, preco: { $gt: 0 } })
        .sort({ data_verificacao: -1 })
        .limit(1)
        .toArray();
    return ultimo.length > 0 ? ultimo[0].preco : null;
}

// ============================================================================
// 4. FUNÇÃO: EXTRAIR PREÇO E INFORMAÇÕES DOS DADOS DA VTEX
// ============================================================================
function extrairDadosProduto(data, produtoNome) {
    if (!data || data.length === 0) return null;

    // Percorre todos os itens (variações)
    for (const item of data) {
        if (!item.items || item.items.length === 0) continue;
        for (const variant of item.items) {
            if (!variant.sellers) continue;
            for (const seller of variant.sellers) {
                const offer = seller.commertialOffer;
                if (offer && offer.Price > 0) {
                    return {
                        preco: offer.Price,
                        nomeLojaOrigem: seller.sellerName || 'Atacadão',
                        link: item.link || `https://www.atacadao.com.br/${item.linkText}/p`,
                        sku: variant.itemId
                    };
                }
            }
        }
    }
    return null; // preço zero ou nenhum seller com estoque
}

// ============================================================================
// 5. FUNÇÃO: BUSCAR PRODUTO POR EAN (com fallback por nome)
// ============================================================================
async function buscarProduto(host, sc, regionId, ean, nomeProduto) {
    // Tenta por EAN
    let url = `${host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}`;
    if (sc) url += `&sc=${sc}`;
    if (regionId) url += `&regionId=${regionId}`;
    url += `&_=${Date.now()}`;

    let dados = await buscarDadosComRetry(url);
    if (dados && dados.length > 0) {
        const extraido = extrairDadosProduto(dados);
        if (extraido) return extraido;
    }

    // Fallback: busca por nome (mais amplo)
    const nomeClean = nomeProduto.replace(/[^\w\s]/g, '').trim();
    if (nomeClean.length > 3) {
        const urlNome = `${host}/api/catalog_system/pub/products/search?fq=productName:${encodeURIComponent(nomeClean)}&sc=${sc || ''}&regionId=${regionId || ''}&_=${Date.now()}`;
        dados = await buscarDadosComRetry(urlNome);
        if (dados && dados.length > 0) {
            // Filtra para encontrar o mais parecido com o nome original (evitar falsos positivos)
            const candidatos = dados.filter(p => {
                const nomeProd = p.productName?.toLowerCase() || '';
                return nomeProd.includes(nomeProduto.toLowerCase().substring(0, 10));
            });
            if (candidatos.length > 0) {
                const extraido = extrairDadosProduto(candidatos);
                if (extraido) return extraido;
            }
        }
    }
    return null;
}

// ============================================================================
// 6. FUNÇÃO PRINCIPAL – AZURE FUNCTION
// ============================================================================
module.exports = async function (context, req) {
    const configs = [
        {
            id: 'ATACADAO',
            nome: "Atacadão",
            host: 'https://www.atacadao.com.br',
            scList: [1, 2, null] // tenta com sc=1, sc=2 e sem sc
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

        // Obtém regionId dinâmico para o CEP
        const regionId = await obterRegionId(CEP_PADRAO);
        context.log(`RegionId obtido: ${regionId}`);

        // Busca produtos ativos com EAN
        const monitorados = await dicionarioCol.find({ monitorar: true, ean: { $exists: true, $ne: "" } }).toArray();
        if (monitorados.length === 0) {
            context.res = { status: 200, body: { aviso: "Nenhum produto válido." } };
            return;
        }

        for (const prod of monitorados) {
            const produtoNome = prod.nome_comum;
            const ean = prod.ean;
            let produtoEncontrado = false;
            let resultadoLoja = null;

            // Para cada loja (só Atacadão, mas mantém estrutura)
            for (const lojaConfig of configs) {
                let encontrado = false;
                // Tenta cada salesChannel
                for (const sc of lojaConfig.scList) {
                    const dadosExtraidos = await buscarProduto(
                        lojaConfig.host,
                        sc,
                        regionId,
                        ean,
                        produtoNome
                    );
                    if (dadosExtraidos) {
                        encontrado = true;
                        resultadoLoja = {
                            produto: produtoNome,
                            loja: lojaConfig.nome,
                            origem: dadosExtraidos.nomeLojaOrigem,
                            link: dadosExtraidos.link,
                            preco: dadosExtraidos.preco,
                            sku: dadosExtraidos.sku
                        };
                        break; // achou com este sc
                    }
                }
                if (encontrado) break; // já achou na loja
            }

            // Se não encontrou, registra como não encontrado
            if (!resultadoLoja) {
                relatorio.push({
                    produto: produtoNome,
                    loja: 'Atacadão',
                    origem: 'N/A',
                    status: 'NÃO ENCONTRADO OU SEM ESTOQUE',
                    preco: 0,
                    referencia_usada: null,
                    ultimoPrecoWeb: null,
                    link: ''
                });
                continue;
            }

            // Se encontrou, processa
            const precoAtual = resultadoLoja.preco;
            // Obtém último preço web para comparação
            const ultimoPrecoWeb = await obterUltimoPrecoValido(db, produtoNome, 'Atacadão');
            const precoReferencia = prod.preco_alvo || ultimoPrecoWeb || Infinity;
            const temAlvo = precoReferencia !== Infinity;

            // Monta relatório
            const entry = {
                produto: produtoNome,
                loja: 'Atacadão',
                origem: resultadoLoja.origem,
                status: precoAtual > 0 ? 'ENCONTRADO' : 'SEM ESTOQUE (Preço 0,00)',
                preco: precoAtual,
                referencia_usada: temAlvo ? precoReferencia : null,
                ultimoPrecoWeb: ultimoPrecoWeb,
                link: resultadoLoja.link || ''
            };
            relatorio.push(entry);

            // Disparo de alerta se preço baixou em relação à meta ou ao último preço
            if (precoAtual > 0 && temAlvo && precoAtual < precoReferencia) {
                const jaExiste = await alertasCol.findOne({
                    produto_nome: produtoNome,
                    loja: 'Atacadão',
                    preco_atual: precoAtual,
                    status_notificacao: 'pendente'
                });
                if (!jaExiste) {
                    await alertasCol.insertOne({
                        produto_nome: produtoNome,
                        loja: 'Atacadão',
                        preco_historico: precoReferencia,
                        preco_atual: precoAtual,
                        link_compra: resultadoLoja.link,
                        data_alerta: new Date(),
                        status_notificacao: 'pendente'
                    });
                }
            }

            // Salva histórico APENAS se houve mudança (preço diferente do último)
            if (ultimoPrecoWeb === null || precoAtual !== ultimoPrecoWeb) {
                await db.collection('historico_precos_web').insertOne({
                    nome: produtoNome,
                    ean: prod.ean,
                    loja: 'Atacadão',
                    origem: resultadoLoja.origem,
                    preco: precoAtual,
                    data_verificacao: new Date()
                });
            }
        }

        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: relatorio
        };

    } catch (e) {
        context.log.error('Erro crítico:', e);
        context.res = {
            status: 500,
            body: { erro: 'Erro Crítico: ' + e.message }
        };
    } finally {
        if (client) await client.close();
    }
};