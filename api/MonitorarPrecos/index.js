const { MongoClient } = require('mongodb');
const stringSimilarity = require('string-similarity-js'); // npm install string-similarity-js

// ============================================================
// 1. FUNÇÕES AUXILIARES
// ============================================================

function normalizarTexto(texto) {
    return texto.toUpperCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extrairVolume(texto) {
    const normalizado = normalizarTexto(texto);
    const match = normalizado.match(/(\d+[.,]?\d*)\s*(KG|G|L|ML|LITROS|GRAMAS|UN|UND|UNIDADES)/i);
    if (!match) return null;

    let valor = parseFloat(match[1].replace(',', '.'));
    let unidade = match[2].toUpperCase();

    if (['LITROS', 'L'].includes(unidade)) { valor *= 1000; unidade = 'ML'; }
    if (['GRAMAS', 'G'].includes(unidade)) unidade = 'G';
    if (unidade === 'KG') { valor *= 1000; unidade = 'G'; }

    return { valor: Math.round(valor), unidade };
}

function volumesCompativeis(volBanco, volSite) {
    if (!volBanco || !volSite) return true;

    const conv = { 'G': 1, 'ML': 1, 'KG': 1000, 'L': 1000 };
    const v1 = volBanco.valor * (conv[volBanco.unidade] || 1);
    const v2 = volSite.valor * (conv[volSite.unidade] || 1);

    const diffPercent = Math.abs(v1 - v2) / Math.max(v1, v2);
    return diffPercent <= 0.18; // 18% de tolerância
}

function isMultipack(texto) {
    const normalizado = normalizarTexto(texto);
    return /(PACOTE|KIT|CAIXA|CX|UNIDADES|UN\s*\.|UN\b|\d\s*[Xx]\s*\d|\d\s*[Xx]\s*[A-Z])/.test(normalizado);
}

const MARCAS_CONHECIDAS = [
    'WICKBOLD', 'PULLMAN', 'MELITTA', 'MELITA', 'NESTLE', 'ACTIVIA', 'ELMA CHIPS',
    'SCOTCH BRITE', 'NATURAL ONE', 'MOLICO', 'DANONE', 'COLGATE', 'PANCO', 'PENSE',
    'BATAVO', 'VIGOR', 'PAULISTA', 'SADIA', 'PRESIDENT', 'PRÉSIDENT', 'DOVE', 'SEDA',
    'NIVEA', 'JOHNSON', 'REXONA', 'BRIGITTA', 'FUGINI', 'PREDILECTA', 'CARREFOUR'
];

function validarMarca(nomeBanco, nomeSite) {
    const nb = normalizarTexto(nomeBanco);
    const ns = normalizarTexto(nomeSite);
    return MARCAS_CONHECIDAS.some(m => nb.includes(m) && ns.includes(m));
}

function calcularScore(nomeBanco, nomeSite) {
    const a = normalizarTexto(nomeBanco);
    const b = normalizarTexto(nomeSite);

    const sim = stringSimilarity.compareTwoStrings(a, b);
    const palavrasBanco = a.split(' ').filter(p => p.length > 2);
    const palavrasSite = b.split(' ').filter(p => p.length > 2);

    const interseccao = palavrasBanco.filter(p => palavrasSite.includes(p));
    const scoreJaccard = palavrasBanco.length > 0 ? interseccao.length / new Set([...palavrasBanco, ...palavrasSite]).size : 0;

    return Math.round(sim * 100 + scoreJaccard * 50);
}

function construirTermosBusca(nomeProduto) {
    const normal = normalizarTexto(nomeProduto);
    const volume = extrairVolume(nomeProduto);
    const marca = MARCAS_CONHECIDAS.find(m => normal.includes(m)) || '';

    const termos = [
        nomeProduto.split(' ').slice(0, 5).join(' '),
        `${marca} ${volume ? volume.valor + volume.unidade : ''}`.trim(),
        normal.split(' ').filter(p => p.length > 3).slice(0, 4).join(' ')
    ];

    return [...new Set(termos.filter(Boolean))]; // remove duplicados
}

// ============================================================
// 2. CACHE
// ============================================================

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 12; // 12 minutos

async function buscarProdutos(url, loja, termo) {
    const chave = `${loja}:${termo}`;
    const cached = cache.get(chave);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }

    try {
        const res = await fetch(url, { 
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PriceMonitor/1.0)' } 
        });
        const data = res.ok ? await res.json() : [];
        cache.set(chave, { data, timestamp: Date.now() });
        return data;
    } catch (e) {
        console.error(`Erro ao buscar ${termo} na ${loja}:`, e.message);
        return [];
    }
}

// ============================================================
// 3. MATCHING PRINCIPAL
// ============================================================

function filtrarMelhorMatch(produto, itens) {
    let melhorMatch = null;
    let maiorScore = -1;

    const volBanco = extrairVolume(produto.nome_comum);

    for (const item of itens) {
        const nomeSite = item.productName || '';
        const score = calcularScore(produto.nome_comum, nomeSite);
        const marcaBate = validarMarca(produto.nome_comum, nomeSite);
        const volumeBate = volumesCompativeis(volBanco, extrairVolume(nomeSite));
        const multipackBate = isMultipack(produto.nome_comum) === isMultipack(nomeSite);

        let aceita = false;

        if (score >= 75) aceita = true;
        else if (score >= 58 && marcaBate && volumeBate) aceita = true;
        else if (score >= 65 && marcaBate) aceita = true;

        if (aceita && score > maiorScore) {
            maiorScore = score;
            melhorMatch = item;
        }
    }

    return melhorMatch;
}

// ============================================================
// 4. FUNÇÃO PRINCIPAL
// ============================================================

module.exports = async function (context, req) {
    const configs = [
        { id: 'SAMS', nome: "Sam's Club", host: 'https://www.samsclub.com.br' },
        { id: 'CARREFOUR', nome: "Carrefour", host: 'https://www.carrefour.com.br' },
        { id: 'ATACADAO', nome: "Atacadão", host: 'https://www.atacadao.com.br' }
    ];

    let client = null;
    const relatorioVarredura = [];

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const db = client.db('app_compras');
        const dicionarioCol = db.collection('dicionario_produtos');
        const alertasCol = db.collection('alertas_preco');

        const monitorados = await dicionarioCol.find({ monitorar: true }).toArray();
        let totalAlertas = 0;

        for (const prod of monitorados) {
            const menorPrecoHistorico = await obterMenorPrecoHistorico(db, prod.nome_comum);
            const precoReferencia = prod.preco_alvo || menorPrecoHistorico || Infinity;

            if (precoReferencia === Infinity) continue;

            for (const lojaConfig of configs) {
                let melhorMatch = null;
                const termos = construirTermosBusca(prod.nome_comum);

                for (const termo of termos) {
                    const url = `${lojaConfig.host}/api/catalog_system/pub/products/search/${encodeURIComponent(termo)}?_from=0&_to=25`;
                    const data = await buscarProdutos(url, lojaConfig.id, termo);

                    if (data && data.length > 0) {
                        melhorMatch = filtrarMelhorMatch(prod, data);
                        if (melhorMatch) break;
                    }
                }

                let statusAcao = "Sem estoque / Sem match";

                if (melhorMatch) {
                    const precoAtual = melhorMatch.items?.[0]?.sellers?.[0]?.commertialOffer?.Price || 0;

                    if (precoAtual > 0) {
                        const quedaPercentual = precoReferencia > 0 ? (precoReferencia - precoAtual) / precoReferencia : 0;

                        if (precoAtual < precoReferencia && quedaPercentual > 0.08) { // mínimo 8% de queda
                            const alertaExistente = await alertasCol.findOne({
                                produto_nome: prod.nome_comum,
                                loja: lojaConfig.nome,
                                status_notificacao: "pendente"
                            });

                            if (!alertaExistente) {
                                await alertasCol.insertOne({
                                    produto_nome: prod.nome_comum,
                                    loja: lojaConfig.nome,
                                    preco_historico: precoReferencia,
                                    preco_atual: precoAtual,
                                    link_compra: melhorMatch.link || melhorMatch.href,
                                    data_alerta: new Date(),
                                    status_notificacao: "pendente"
                                });
                                totalAlertas++;
                                statusAcao = "🚨 ALERTA SALVO NA FILA!";
                            } else {
                                statusAcao = "⏳ Alerta já pendente";
                            }
                        } else {
                            statusAcao = `Preço Normal (Queda: ${(quedaPercentual * 100).toFixed(1)}%)`;
                        }
                    }

                    relatorioVarredura.push({
                        produto_buscado: prod.nome_comum,
                        loja: lojaConfig.nome,
                        alvo_ou_historico: precoReferencia,
                        preco_site: precoAtual,
                        score: melhorMatch ? calcularScore(prod.nome_comum, melhorMatch.productName) : null,
                        status_da_varredura: statusAcao
                    });
                } else {
                    relatorioVarredura.push({
                        produto_buscado: prod.nome_comum,
                        loja: lojaConfig.nome,
                        status_da_varredura: "Item rejeitado ou não encontrado"
                    });
                }
            }
        }

        context.res = {
            status: 200,
            body: {
                mensagem: "Varredura finalizada com algoritmo melhorado",
                total_alertas_na_fila: totalAlertas,
                detalhes_da_varredura: relatorioVarredura
            }
        };

    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};

// Função auxiliar mantida
async function obterMenorPrecoHistorico(db, nomeProduto) {
    const primeiraPalavra = nomeProduto.split(' ')[0];
    const pipeline = [
        { $unwind: "$itens" },
        { $match: { "itens.descricao": { $regex: primeiraPalavra, $options: 'i' } } },
        { $group: { _id: null, menorPreco: { $min: "$itens.preco_unitario" } } }
    ];
    const result = await db.collection("historico_precos").aggregate(pipeline).toArray();
    return result.length > 0 ? result[0].menorPreco : Infinity;
}