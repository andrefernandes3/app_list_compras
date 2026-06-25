const { MongoClient } = require('mongodb');

// ============================================================
// 1. FUNÇÕES AUXILIARES MELHORADAS
// ============================================================

const ABREVIACOES_COMPARACAO = {
    'GDE': 'GRANDE',
    'PEQ': 'PEQUENO',
    'UN': 'UNIDADES',
    'RL': 'ROLOS',
    'LT': 'LITRO',
    'KG': 'QUILO',
    'ML': 'MILILITRO',
    'C/': 'COM',
    'S/': 'SEM',
};

const MARCAS_CONHECIDAS = [
    'WICKBOLD','PULLMAN','MELITTA','NESTLE','ACTIVIA','ELMA CHIPS',
    'SCOTCH BRITE','NATURAL ONE','MOLICO','DANONE','COLGATE','PANCO',
    'PENSE','BATAVO','VIGOR','PAULISTA','SADIA','PRESIDENT','DOVE',
    'SEDA','NIVEA','JOHNSON','REXONA','CRF','EMBALIXO','VALGROUP',
    'ALTACOPPO','CRISTALCOPO','HIGIPACK','PIQUITUCHO','PONJITA',
    'TIROLEZ','BUFALO','OLIMPO','TUPI','DESTAC','SANOL','DAI',
    'RADIUM','SWIFT','GRACIANA','ITALAC','ITAMBE','PATO','MINUANO',
    'YPE','DOWNY','VANISH','VEJA','BRILHANTE','LIMPOL','URCA',
    'AURORA','BECEL','PROTEX','CARREFOUR'
];

const TERMINOS_IGNORADOS = ['DE', 'DO', 'DA', 'DOS', 'DAS', 'COM', 'SEM', 'POR', 'PARA', 'EM'];

function normalizarTexto(texto) {
    return texto
        .toString()
        .toUpperCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function expandirParaComparacao(texto) {
    let normalizado = texto.toUpperCase();
    for (const [abrev, completo] of Object.entries(ABREVIACOES_COMPARACAO)) {
        normalizado = normalizado.replace(new RegExp(`\\b${abrev}\\b`, 'g'), completo);
    }
    return normalizado;
}

function normalizarParaComparacao(texto) {
    const normalizado = normalizarTexto(texto);
    return expandirParaComparacao(normalizado);
}

function normalizarVolume(valor, unidade) {
    const mapUnidade = {
        'KG': 'G',
        'KILO': 'G',
        'GR': 'G',
        'GRS': 'G',
        'GRAMAS': 'G',
        'G': 'G',
        'L': 'ML',
        'LT': 'ML',
        'LITROS': 'ML',
        'ML': 'ML'
    };

    const unidadeCanonica = mapUnidade[unidade] || unidade;
    let quantidade = Number(valor);
    if (['KG', 'KILO'].includes(unidade)) quantidade = quantidade * 1000;
    if (['L', 'LT', 'LITROS'].includes(unidade)) quantidade = quantidade * 1000;
    return { amount: Math.round(quantidade), unit: unidadeCanonica };
}

function extrairVolume(texto) {
    const normalizado = normalizarTexto(texto);
    const padraoPack = normalizado.match(/\b(\d+)\s*[x×]\s*(\d+[.,]?\d*)\s*(KG|KILO|G|GR|GRS|GRAMAS|ML|L|LT|LITROS)\b/);
    if (padraoPack) {
        const quantidade = Number(padraoPack[1]);
        const valor = parseFloat(padraoPack[2].replace(',', '.'));
        const unidade = padraoPack[3];
        return normalizarVolume(quantidade * valor, unidade);
    }

    const padraoSimples = normalizado.match(/\b(\d+[.,]?\d*)\s*(KG|KILO|G|GR|GRS|GRAMAS|ML|L|LT|LITROS)\b/);
    if (!padraoSimples) return null;

    const valor = parseFloat(padraoSimples[1].replace(',', '.'));
    const unidade = padraoSimples[2];
    return normalizarVolume(valor, unidade);
}

function extrairMultipack(texto) {
    const normalizado = normalizarTexto(texto);
    const padraoX = normalizado.match(/\b(\d+)\s*[x×]\s*(\d+)\b/);
    if (padraoX) return Number(padraoX[1]);

    const padraoPalavras = normalizado.match(/\b(PACOTE|PACK|KIT|CAIXA)\b.*?(\d+)\b/);
    if (padraoPalavras) return Number(padraoPalavras[2]);

    return null;
}

function volumesCompativeis(volBanco, volSite) {
    if (!volBanco || !volSite) return true;
    if (volBanco.unit !== volSite.unit) return false;
    const diff = Math.abs(volBanco.amount - volSite.amount);
    const tolerancia = Math.max(volBanco.amount, volSite.amount) * 0.12;
    return diff <= tolerancia;
}

function validarMarca(nomeBanco, nomeSite) {
    const banco = normalizarParaComparacao(nomeBanco);
    const site = normalizarParaComparacao(nomeSite);
    const marcaBanco = MARCAS_CONHECIDAS.find(m => banco.includes(m));
    if (!marcaBanco) return true;
    return site.includes(marcaBanco);
}

function palavrasSignificativas(texto, minLen = 3) {
    return normalizarTexto(texto)
        .split(' ')
        .filter(p => p.length >= minLen && !TERMINOS_IGNORADOS.includes(p));
}

function calcularScore(nomeBanco, nomeSite) {
    const banco = normalizarParaComparacao(nomeBanco);
    const site = normalizarParaComparacao(nomeSite);

    const palavrasBanco = banco.split(' ').filter(p => p.length > 2 && !TERMINOS_IGNORADOS.includes(p));
    const palavrasSite = site.split(' ').filter(p => p.length > 2 && !TERMINOS_IGNORADOS.includes(p));

    if (palavrasBanco.length === 0 || palavrasSite.length === 0) return 0;

    const matches = palavrasBanco.filter(p => palavrasSite.includes(p));
    const proporcao = matches.length / palavrasBanco.length;
    const pesoInicio = palavrasBanco.slice(0, 3).filter(p => palavrasSite.includes(p)).length;
    const chaves = ['ZERO', 'LIGHT', 'SEM AÇUCAR', 'SEM ACUCAR', 'ZERO LACTOSE', 'DIET'];
    const bonusChave = chaves.filter(p => banco.includes(p) && site.includes(p)).length * 2;

    return Math.round((proporcao * 10) + pesoInicio + bonusChave);
}

function construirTermoBusca(nomeProduto) {
    const palavras = palavrasSignificativas(nomeProduto);
    const volume = extrairVolume(nomeProduto);
    const termos = palavras.slice(0, 3);
    if (volume) termos.push(`${volume.amount}${volume.unit}`);
    return termos.join(' ');
}

function construirTermoFallback(produto) {
    const nome = normalizarTexto(produto.nome_comum);
    const marca = MARCAS_CONHECIDAS.find(m => nome.includes(m));
    const volume = extrairVolume(nome);
    const termos = [];
    if (marca) termos.push(marca);
    if (volume) termos.push(`${volume.amount}${volume.unit}`);
    if (termos.length === 0) return construirTermoBusca(produto.nome_comum);
    return termos.join(' ');
}

// ============================================================
// 2. FUNÇÃO DE BUSCA COM CACHE
// ============================================================

const cache = new Map();

async function buscarProdutos(url, loja, termo) {
    const chave = `${loja}:${termo}`;
    if (cache.has(chave)) return cache.get(chave);
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = res.ok ? await res.json() : [];
        const resultado = Array.isArray(data) ? data : [];
        cache.set(chave, resultado);
        return resultado;
    } catch (error) {
        return [];
    }
}

// ============================================================
// 3. FILTRAGEM DO MELHOR MATCH
// ============================================================

function filtrarMelhorMatch(produto, itens) {
    let melhorMatch = null;
    let maiorScore = -1;
    const temMultipackBanco = extrairMultipack(produto.nome_comum) !== null;
    const volumeBanco = extrairVolume(produto.nome_comum);

    itens.forEach(item => {
        const nomeSite = item.productName || item.productName || '';
        const score = calcularScore(produto.nome_comum, nomeSite);
        if (score < 3) return;

        const volumeSite = extrairVolume(nomeSite);
        if (!volumesCompativeis(volumeBanco, volumeSite)) return;

        if (!validarMarca(produto.nome_comum, nomeSite)) return;

        const multipackSite = extrairMultipack(nomeSite) !== null;
        if (temMultipackBanco !== multipackSite) return;

        if (score > maiorScore) {
            maiorScore = score;
            melhorMatch = item;
        }
    });

    return melhorMatch;
}

// ============================================================
// 4. FUNÇÃO PRINCIPAL
// ============================================================

module.exports = async function (context, req) {
    const loja = (req.query.loja || 'SAMS').toUpperCase();
    const configs = {
        'SAMS': { host: 'https://www.samsclub.com.br' },
        'CARREFOUR': { host: 'https://www.carrefour.com.br' },
        'ATACADAO': { host: 'https://www.atacadao.com.br' }
    };

    if (!configs[loja]) {
        context.res = { status: 400, body: { erro: "Loja não suportada. Use SAMS, CARREFOUR ou ATACADAO." } };
        return;
    }

    let relatorio = { loja, resultados: [] };
    let client = null;

    try {
        client = new MongoClient(process.env["MONGODB_URI"]);
        await client.connect();
        const colecao = client.db('app_compras').collection('dicionario_produtos');
        const monitorados = await colecao.find({ monitorar: true }).toArray();

        for (const prod of monitorados) {
            let resultado = { seu_item: prod.nome_comum, status: "NÃO ENCONTRADO" };

            try {
                const termo = construirTermoBusca(prod.nome_comum);
                const termoEncoded = encodeURIComponent(termo);
                let url = `${configs[loja].host}/api/catalog_system/pub/products/search/${termoEncoded}?_from=0&_to=50`;
                let data = await buscarProdutos(url, loja, termo);

                if (!data || data.length === 0) {
                    const termoCompleto = encodeURIComponent(normalizarTexto(prod.nome_comum));
                    url = `${configs[loja].host}/api/catalog_system/pub/products/search/${termoCompleto}?_from=0&_to=50`;
                    data = await buscarProdutos(url, loja, termoCompleto);
                }

                if (!data || data.length === 0) {
                    const termoFallback = construirTermoFallback(prod);
                    const fallbackEncoded = encodeURIComponent(termoFallback);
                    url = `${configs[loja].host}/api/catalog_system/pub/products/search/${fallbackEncoded}?_from=0&_to=50`;
                    data = await buscarProdutos(url, loja, termoFallback);
                }

                if (data && data.length > 0) {
                    const melhorMatch = filtrarMelhorMatch(prod, data);
                    if (melhorMatch && melhorMatch.items?.[0]?.sellers?.[0]?.commertialOffer) {
                        const oferta = melhorMatch.items[0].sellers[0].commertialOffer;
                        resultado = {
                            seu_item: prod.nome_comum,
                            item_oficial_site: melhorMatch.productName,
                            nota_de_precisao: calcularScore(prod.nome_comum, melhorMatch.productName),
                            preco_site: oferta.Price,
                            status: oferta.Price > 0 ? "ENCONTRADO" : "SEM ESTOQUE"
                        };
                    }
                }
            } catch (e) {
                context.log(`Erro em ${prod.nome_comum}:`, e.message);
            }

            relatorio.resultados.push(resultado);
        }
        context.res = { status: 200, body: relatorio };
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};
