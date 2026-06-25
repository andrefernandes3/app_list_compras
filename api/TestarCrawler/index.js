const { MongoClient } = require('mongodb');

// ============================================================
// 1. FUNÇÕES AUXILIARES DE NORMALIZAÇÃO E EXTRAÇÃO
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

    return { valor: Math.round(valor), unidade };
}

// Agora aceita ML e G como compatíveis (densidade ~1)
function volumesCompativeis(volBanco, volSite) {
    if (!volBanco || !volSite) return true;

    let { valor: v1, unidade: u1 } = volBanco;
    let { valor: v2, unidade: u2 } = volSite;

    // Se as unidades são diferentes, convertemos ML para G (ou vice-versa) assumindo densidade 1
    if (u1 === 'ML' && u2 === 'G') {
        v2 = v2; // ML e G são tratados como equivalentes numéricos
    } else if (u1 === 'G' && u2 === 'ML') {
        v1 = v1;
    } else if (u1 !== u2) {
        return false; // unidades incompatíveis (ex: L vs G não mapeado)
    }

    const tolerancia = 0.05; // 5%
    const diff = Math.abs(v1 - v2);
    return diff <= (v1 * tolerancia);
}

function isMultipack(texto) {
    const normalizado = normalizarTexto(texto);
    return /(PACOTE COM|KIT|CAIXA COM|CX COM|UNIDADES|UN\s*\.|UN\b|\d\s*[Xx]\s*\d|\d\s*[Xx]\s*[A-Z])/.test(normalizado);
}

// Lista ampliada de marcas (incluindo iogurtes)
function validarMarca(nomeBanco, nomeSite) {
    const marcas = [
        'WICKBOLD', 'PULLMAN', 'MELITTA', 'NESTLE', 'ACTIVIA', 'ELMA CHIPS',
        'SCOTCH BRITE', 'NATURAL ONE', 'MOLICO', 'DANONE', 'COLGATE', 'PANCO',
        'PENSE', 'BATAVO', 'VIGOR', 'PAULISTA', 'SADIA', 'PRESIDENT', 'DOVE',
        'SEDA', 'NIVEA', 'JOHNSON', 'REXONA', 'CRF', 'EMBALIXO', 'VALGROUP',
        'ALTACOPPO', 'CRISTALCOPO', 'HIGIPACK', 'PIQUITUCHO', 'PONJITA'
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

    // Jaccard
    const interseccao = palavrasBanco.filter(p => palavrasSite.includes(p));
    const uniao = new Set([...palavrasBanco, ...palavrasSite]);
    let score = uniao.size > 0 ? interseccao.length / uniao.size : 0;

    // Peso extra para as 3 primeiras palavras
    const primeirasBanco = banco.split(' ').slice(0, 3);
    const primeirasSite = site.split(' ').slice(0, 3);
    const pesoInicio = primeirasBanco.filter(p => primeirasSite.includes(p)).length;

    // Bônus para palavras-chave (ZERO, LIGHT, SEM AÇÚCAR)
    const palavrasChave = ['ZERO', 'LIGHT', 'SEM ACUCAR', 'SEM AÇÚCAR'];
    const bonusChave = palavrasChave.filter(p => banco.includes(p) && site.includes(p)).length * 2;

    return Math.round((score * 10) + pesoInicio + bonusChave);
}

function construirTermoBusca(nomeProduto) {
    const normalizado = normalizarTexto(nomeProduto);
    const palavras = normalizado.split(' ').filter(p => p.length > 2);

    // Tenta incluir marca e volume se existirem
    const marcas = ['WICKBOLD','PULLMAN','MELITTA','NESTLE','ACTIVIA','ELMA CHIPS',
                    'SCOTCH BRITE','NATURAL ONE','MOLICO','DANONE','COLGATE','PANCO',
                    'PENSE','BATAVO','VIGOR','PAULISTA','SADIA','PRESIDENT','DOVE',
                    'SEDA','NIVEA','JOHNSON','REXONA','CRF','EMBALIXO','VALGROUP',
                    'ALTACOPPO','CRISTALCOPO','HIGIPACK','PIQUITUCHO','PONJITA'];
    let marca = marcas.find(m => normalizado.includes(m));
    let volume = extrairVolume(normalizado);
    let termoParts = [];

    if (marca) termoParts.push(marca);
    // Pega as palavras mais relevantes (até 5) excluindo a marca já adicionada
    let palavrasRestantes = palavras.filter(p => p !== marca);
    if (volume) {
        // Adiciona o volume como "1.15KG" ou "1150G" – melhor usar o valor + unidade original
        const volStr = `${volume.valor}${volume.unidade}`;
        termoParts.push(volStr);
        palavrasRestantes = palavrasRestantes.filter(p => !p.includes(volume.valor.toString()));
    }
    termoParts.push(...palavrasRestantes.slice(0, 5 - termoParts.length));

    return termoParts.join(' ');
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
    } catch (e) {
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
// 4. FUNÇÃO PRINCIPAL (AZURE FUNCTION)
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
            let resultado = { 
                seu_item: prod.nome_comum, 
                status: "NÃO ENCONTRADO" 
            };
            
            try {
                // Busca principal
                const termo = construirTermoBusca(prod.nome_comum);
                const termoEncoded = encodeURIComponent(termo);
                let url = `${configs[loja].host}/api/catalog_system/pub/products/search/${termoEncoded}?_from=0&_to=20`;
                let data = await buscarProdutos(url, loja, termo);

                // Fallback 1: busca com nome completo
                if (!data || data.length === 0) {
                    const termoCompleto = encodeURIComponent(normalizarTexto(prod.nome_comum));
                    url = `${configs[loja].host}/api/catalog_system/pub/products/search/${termoCompleto}?_from=0&_to=20`;
                    data = await buscarProdutos(url, loja, termoCompleto);
                }

                // Fallback 2: busca apenas com marca + volume
                if (!data || data.length === 0) {
                    const vol = extrairVolume(prod.nome_comum);
                    const marca = normalizarTexto(prod.nome_comum).split(' ').find(p => 
                        ['WICKBOLD','PULLMAN','MELITTA','NESTLE','ACTIVIA','ELMA CHIPS',
                         'SCOTCH BRITE','NATURAL ONE','MOLICO','DANONE','COLGATE','PANCO',
                         'PENSE','BATAVO','VIGOR','PAULISTA','SADIA','PRESIDENT','DOVE',
                         'SEDA','NIVEA','JOHNSON','REXONA','CRF','EMBALIXO','VALGROUP',
                         'ALTACOPPO','CRISTALCOPO','HIGIPACK','PIQUITUCHO','PONJITA'].includes(p)
                    );
                    if (marca && vol) {
                        const termoFallback = `${marca} ${vol.valor}${vol.unidade}`;
                        const fallbackEncoded = encodeURIComponent(termoFallback);
                        url = `${configs[loja].host}/api/catalog_system/pub/products/search/${fallbackEncoded}?_from=0&_to=20`;
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