const { MongoClient } = require('mongodb');

// ============================================================
// 1. FUNÇÕES AUXILIARES (primeira versão, estável)
// ============================================================

function normalizarTexto(texto) {
    return texto
        .toUpperCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extrairVolume(texto) {
    const normalizado = normalizarTexto(texto);
    const match = normalizado.match(/(\d+[.,]?\d*)\s*(KG|G|L|ML|LITROS|GRAMAS)/);
    if (!match) return null;

    let valor = parseFloat(match[1].replace(',', '.'));
    let unidade = match[2];

    if (unidade === 'LITROS') unidade = 'L';
    if (unidade === 'GRAMAS') unidade = 'G';

    if (unidade === 'KG') { valor *= 1000; unidade = 'G'; }
    if (unidade === 'L')  { valor *= 1000; unidade = 'ML'; }

    return `${Math.round(valor)}${unidade}`;
}

function volumesCompativeis(volBanco, volSite) {
    if (!volBanco || !volSite) return true;
    const numBanco = parseFloat(volBanco);
    const numSite = parseFloat(volSite);
    const unidadeBanco = volBanco.replace(/[\d.]/g, '');
    const unidadeSite = volSite.replace(/[\d.]/g, '');
    if (unidadeBanco !== unidadeSite) return false;
    const tolerancia = 0.08; // 8% (antes 5%)
    const diff = Math.abs(numBanco - numSite);
    return diff <= (numBanco * tolerancia);
}

function isMultipack(texto) {
    const normalizado = normalizarTexto(texto);
    return /(PACOTE COM|KIT|CAIXA COM|CX COM|UNIDADES|UN\s*\.|UN\b|\d\s*[Xx]\s*\d)/.test(normalizado);
}

function validarMarca(nomeBanco, nomeSite) {
    const marcas = [
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
    const normalizadoBanco = normalizarTexto(nomeBanco);
    const normalizadoSite = normalizarTexto(nomeSite);

    const marcaBanco = marcas.find(m => normalizadoBanco.includes(m));
    if (!marcaBanco) return true;

    return normalizadoSite.includes(marcaBanco);
}

function calcularScore(nomeBanco, nomeSite) {
    const banco = normalizarTexto(nomeBanco);
    const site = normalizarTexto(nomeSite);

    const palavrasBanco = banco.split(' ').filter(p => p.length > 2);
    const palavrasSite = site.split(' ').filter(p => p.length > 2);

    if (palavrasBanco.length === 0 || palavrasSite.length === 0) return 0;

    const interseccao = palavrasBanco.filter(p => palavrasSite.includes(p));
    const uniao = new Set([...palavrasBanco, ...palavrasSite]);
    let score = uniao.size > 0 ? interseccao.length / uniao.size : 0;

    const primeirasBanco = banco.split(' ').slice(0, 3);
    const primeirasSite = site.split(' ').slice(0, 3);
    const pesoInicio = primeirasBanco.filter(p => primeirasSite.includes(p)).length;

    // Bônus para palavras-chave
    const chaves = ['ZERO', 'LIGHT', 'SEM ACUCAR', 'SEM AÇÚCAR', 'ZERO LACTOSE', 'DIET'];
    const bonusChave = chaves.filter(p => banco.includes(p) && site.includes(p)).length * 2;

    return Math.round((score * 10) + pesoInicio + bonusChave);
}

function construirTermoBusca(nomeProduto) {
    const normalizado = normalizarTexto(nomeProduto);
    const palavras = normalizado.split(' ').filter(p => p.length > 2);
    // Primeiras 3 palavras (comportamento original)
    return palavras.slice(0, 3).join(' ');
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
        cache.set(chave, data);
        return data;
    } catch {
        return [];
    }
}

// ============================================================
// 3. FILTRAGEM DO MELHOR MATCH
// ============================================================

function filtrarMelhorMatch(produto, itens) {
    let melhorMatch = null;
    let maiorScore = -1;

    itens.forEach(item => {
        const nomeBanco = produto.nome_comum;
        const nomeSite = item.productName;

        const score = calcularScore(nomeBanco, nomeSite);
        const volumeBanco = extrairVolume(nomeBanco);
        const volumeSite = extrairVolume(nomeSite);
        const volumeBate = volumesCompativeis(volumeBanco, volumeSite);
        const marcaBate = validarMarca(nomeBanco, nomeSite);
        const multipackBate = isMultipack(nomeBanco) === isMultipack(nomeSite);

        if (score >= 3 && marcaBate && volumeBate && multipackBate && score > maiorScore) {
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

                // Fallback 1: busca com nome completo
                if (!data || data.length === 0) {
                    const termoCompleto = encodeURIComponent(normalizarTexto(prod.nome_comum));
                    url = `${configs[loja].host}/api/catalog_system/pub/products/search/${termoCompleto}?_from=0&_to=50`;
                    data = await buscarProdutos(url, loja, termoCompleto);
                }

                // Fallback 2: busca com marca + volume (iogurtes e outros)
                if (!data || data.length === 0) {
                    const normalizado = normalizarTexto(prod.nome_comum);
                    const marcas = ['NESTLE','ACTIVIA','DANONE','MOLICO','PENSE','BATAVO','VIGOR','ITAMBE','SADIA','PRESIDENT'];
                    let marca = marcas.find(m => normalizado.includes(m));
                    let volume = extrairVolume(normalizado);
                    if (marca && volume) {
                        const termoFallback = `${marca} ${volume}`;
                        const fallbackEncoded = encodeURIComponent(termoFallback);
                        url = `${configs[loja].host}/api/catalog_system/pub/products/search/${fallbackEncoded}?_from=0&_to=50`;
                        data = await buscarProdutos(url, loja, termoFallback);
                    }
                }
                
                if (data && data.length > 0) {
                    const melhorMatch = filtrarMelhorMatch(prod, data);
                    
                    if (melhorMatch) {
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