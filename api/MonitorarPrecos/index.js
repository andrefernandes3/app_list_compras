const { MongoClient } = require('mongodb');

// ============================================================
// CONFIGURAÇÕES E MARCAS
// ============================================================

const MARCAS_CONHECIDAS = [
    'WICKBOLD', 'PULLMAN', 'MELITTA', 'MELITA', 'NESTLE', 'NESTLÉ', 'ACTIVIA',
    'ELMA CHIPS', 'NATURAL ONE', 'MOLICO', 'DANONE', 'COLGATE', 'PANCO', 'PENSE',
    'BATAVO', 'VIGOR', 'PAULISTA', 'SADIA', 'PRESIDENT', 'PRÉSIDENT', 'DOVE',
    'SEDA', 'NIVEA', 'JOHNSON', 'REXONA', 'BRIGITTA', 'FUGINI', 'PREDILECTA',
    'CARREFOUR', 'TIROLEZ', 'YOKI', 'COQUEIRO', 'GOMES DA COSTA', 'ITALAC',
    'QUAKER', 'BAUDUCCO', 'MARILAN', 'CRF', 'EMBALIXO', 'VALGROUP', 'ALTACOPPO',
    'CRISTALCOPO', 'HIGIPACK', 'PIQUITUCHO', 'PONJITA', 'ITAMBE', 'SWIFT', 'LIMPOL'
];

// ============================================================
// FUNÇÕES AUXILIARES
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
    return diffPercent <= 0.18;
}

function isMultipack(texto) {
    const normalizado = normalizarTexto(texto);
    return /(PACOTE|KIT|CAIXA|CX|COM\s*\d|UNIDADES|UN\s*\.|UN\b|\d\s*[Xx]\s*\d)/.test(normalizado);
}

// ====================== FUNÇÃO CORRIGIDA ======================
function calcularScore(nomeBanco, nomeSite) {
    const a = normalizarTexto(nomeBanco);
    const b = normalizarTexto(nomeSite);
    
    const palavrasA = a.split(' ').filter(p => p.length > 2);
    const palavrasB = b.split(' ').filter(p => p.length > 2);
    
    const interseccao = palavrasA.filter(p => palavrasB.includes(p)).length;
    const uniao = new Set([...palavrasA, ...palavrasB]).size;
    
    const jaccard = uniao > 0 ? interseccao / uniao : 0;
    
    let bonus = 0;
    if (MARCAS_CONHECIDAS.some(m => a.includes(m) && b.includes(m))) bonus += 25;
    if ((a.includes('ZERO') && b.includes('ZERO')) || 
        (a.includes('LIGHT') && b.includes('LIGHT'))) bonus += 15;

    return Math.round((jaccard * 100) + bonus);
}

function construirTermosBusca(nomeProduto) {
    const normal = normalizarTexto(nomeProduto);
    const volume = extrairVolume(nomeProduto);
    const marca = MARCAS_CONHECIDAS.find(m => normal.includes(m)) || '';

    const termos = [
        nomeProduto.split(' ').slice(0, 6).join(' '),
        `${marca} ${volume ? volume.valor + volume.unidade : ''}`.trim(),
        normal.split(' ').filter(p => p.length > 3).slice(0, 5).join(' ')
    ];

    return [...new Set(termos.filter(t => t && t.length > 3))];
}

// ============================================================
// CACHE
// ============================================================

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 12; // 12 minutos

async function buscarProdutos(url, loja) {
    const chave = `${loja}:${url}`;
    const cached = cache.get(chave);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PriceMonitor/1.0)' }
        });
        const data = res.ok ? await res.json() : [];
        cache.set(chave, { data, timestamp: Date.now() });
        return data;
    } catch (e) {
        console.error(`Erro na busca ${loja}:`, e.message);
        return [];
    }
}

// ============================================================
// MATCHING
// ============================================================

function filtrarMelhorMatch(produto, itens) {
    let melhor = null;
    let maiorScore = -1;
    const volBanco = extrairVolume(produto.nome_comum);

    for (const item of itens) {
        const nomeSite = item.productName || item.name || '';
        if (!nomeSite) continue;

        const score = calcularScore(produto.nome_comum, nomeSite);
        const marcaBate = MARCAS_CONHECIDAS.some(m => 
            normalizarTexto(produto.nome_comum).includes(m) && 
            normalizarTexto(nomeSite).includes(m)
        );
        const volumeBate = volumesCompativeis(volBanco, extrairVolume(nomeSite));
        const multipackBate = isMultipack(produto.nome_comum) === isMultipack(nomeSite);

        let aceita = score >= 72;
        if (score >= 62 && marcaBate && volumeBate) aceita = true;
        if (score >= 68 && marcaBate) aceita = true;

        if (aceita && score > maiorScore) {
            maiorScore = score;
            melhor = item;
        }
    }
    return melhor;
}

// ============================================================
// FUNÇÃO PRINCIPAL
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
                    const data = await buscarProdutos(url, lojaConfig.id);

                    if (data?.length > 0) {
                        melhorMatch = filtrarMelhorMatch(prod, data);
                        if (melhorMatch) break;
                    }
                }

                let statusAcao = "Sem match";

                if (melhorMatch) {
                    const precoAtual = melhorMatch.items?.[0]?.sellers?.[0]?.commertialOffer?.Price || 0;
                    if (precoAtual > 0) {
                        const queda = precoReferencia > 0 ? (precoReferencia - precoAtual) / precoReferencia : 0;

                        if (precoAtual < precoReferencia && queda > 0.08) {
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
                                statusAcao = "🚨 ALERTA SALVO!";
                            } else {
                                statusAcao = "⏳ Alerta já pendente";
                            }
                        } else {
                            statusAcao = `Preço normal (${(queda * 100).toFixed(1)}% abaixo)`;
                        }
                    }

                    relatorioVarredura.push({
                        produto_buscado: prod.nome_comum,
                        loja: lojaConfig.nome,
                        alvo: precoReferencia,
                        encontrado: precoAtual,
                        score: calcularScore(prod.nome_comum, melhorMatch.productName || ''),
                        status: statusAcao
                    });
                } else {
                    relatorioVarredura.push({
                        produto_buscado: prod.nome_comum,
                        loja: lojaConfig.nome,
                        status: "Não encontrado"
                    });
                }
            }
        }

        context.res = {
            status: 200,
            body: {
                mensagem: "Varredura finalizada (versão melhorada)",
                total_alertas: totalAlertas,
                detalhes: relatorioVarredura
            }
        };
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};

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