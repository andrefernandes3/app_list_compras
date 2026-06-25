const { MongoClient } = require('mongodb');

// ============================================================
// 1. FUNÇÕES AUXILIARES DE NORMALIZAÇÃO E EXPANSÃO
// ============================================================

// Expande abreviações comuns
function expandirAbreviacoes(texto) {
    const mapa = {
        'GDE': 'GRANDE',
        'PEQ': 'PEQUENO',
        'UN': 'UNIDADES',
        'RL': 'ROLOS',
        'LT': 'LITRO',
        'KG': 'QUILO',
        'ML': 'MILILITRO',
        'C/': 'COM',
        'S/': 'SEM',
        'CRF': 'CRF', // mantém
    };
    let normalizado = texto.toUpperCase();
    for (let [abrev, expand] of Object.entries(mapa)) {
        normalizado = normalizado.replace(new RegExp(`\\b${abrev}\\b`, 'g'), expand);
    }
    return normalizado;
}

function normalizarTexto(texto) {
    let t = texto
        .toUpperCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    // Expande abreviações depois da normalização
    t = expandirAbreviacoes(t);
    return t;
}

function extrairVolume(texto) {
    const normalizado = normalizarTexto(texto);
    // Padrão: número (com vírgula ou ponto) + possível espaço + unidade (kg, g, l, ml, litro, grama)
    const match = normalizado.match(/(\d+[.,]?\d*)\s*(KG|G|L|ML|LITROS|GRAMAS|QUILO|MILILITRO)/);
    if (!match) return null;

    let valor = parseFloat(match[1].replace(',', '.'));
    let unidade = match[2];

    if (unidade === 'LITROS' || unidade === 'L') unidade = 'L';
    if (unidade === 'GRAMAS' || unidade === 'G') unidade = 'G';
    if (unidade === 'QUILO') { valor *= 1000; unidade = 'G'; }
    if (unidade === 'MILILITRO') { unidade = 'ML'; }

    if (unidade === 'KG') { valor *= 1000; unidade = 'G'; }
    if (unidade === 'L')  { valor *= 1000; unidade = 'ML'; }

    return { valor: Math.round(valor), unidade };
}

// Compara volumes com tolerância de 8% (aumentei um pouco)
function volumesCompativeis(volBanco, volSite) {
    if (!volBanco || !volSite) return true;

    let { valor: v1, unidade: u1 } = volBanco;
    let { valor: v2, unidade: u2 } = volSite;

    // ML e G são tratados como equivalentes (densidade 1)
    if (u1 === 'ML' && u2 === 'G') {
        // não converte, ambos numéricos
    } else if (u1 === 'G' && u2 === 'ML') {
        // ok
    } else if (u1 !== u2) {
        return false;
    }

    const tolerancia = 0.08; // 8%
    const diff = Math.abs(v1 - v2);
    return diff <= (v1 * tolerancia);
}

// Detecta multipack: considera qualquer quantidade > 1 (ex: 100UN, 30 UNIDADES, 2 ROLOS)
function isMultipack(texto) {
    const normalizado = normalizarTexto(texto);
    // Padrões: número + UN/UNIDADES/ROLOS/UNID, ou "PACOTE COM", "KIT", "CAIXA COM"
    return /(\d+\s*(UN|UNIDADES|ROLOS|UNID)|PACOTE COM|KIT|CAIXA COM|CX COM)/i.test(normalizado);
}

// Lista ampliada de marcas
function validarMarca(nomeBanco, nomeSite) {
    const marcas = [
        'WICKBOLD', 'PULLMAN', 'MELITTA', 'NESTLE', 'ACTIVIA', 'ELMA CHIPS',
        'SCOTCH BRITE', 'NATURAL ONE', 'MOLICO', 'DANONE', 'COLGATE', 'PANCO',
        'PENSE', 'BATAVO', 'VIGOR', 'PAULISTA', 'SADIA', 'PRESIDENT', 'DOVE',
        'SEDA', 'NIVEA', 'JOHNSON', 'REXONA', 'CRF', 'EMBALIXO', 'VALGROUP',
        'ALTACOPPO', 'CRISTALCOPO', 'HIGIPACK', 'PIQUITUCHO', 'PONJITA',
        'TIROLEZ', 'BUFALO', 'OLIMPO', 'TUPI', 'DESTAC', 'SANOL', 'DAI',
        'RADIUM', 'SWIFT', 'GRACIANA', 'ITALAC', 'ITAMBE', 'PATO', 'MINUANO',
        'YPE', 'DOWNY', 'VANISH', 'VEJA', 'BRILHANTE', 'LIMPOL', 'URCA'
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

    // Remove stopwords comuns
    const stopwords = ['COM', 'SEM', 'DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'OU', 'EM', 'PARA'];
    const palavrasBanco = banco.split(' ').filter(p => p.length > 2 && !stopwords.includes(p));
    const palavrasSite = site.split(' ').filter(p => p.length > 2 && !stopwords.includes(p));

    if (palavrasBanco.length === 0 || palavrasSite.length === 0) return 0;

    // Jaccard
    const interseccao = palavrasBanco.filter(p => palavrasSite.includes(p));
    const uniao = new Set([...palavrasBanco, ...palavrasSite]);
    let score = uniao.size > 0 ? interseccao.length / uniao.size : 0;

    // Peso extra para as 3 primeiras palavras
    const primeirasBanco = banco.split(' ').slice(0, 3);
    const primeirasSite = site.split(' ').slice(0, 3);
    const pesoInicio = primeirasBanco.filter(p => primeirasSite.includes(p)).length;

    // Bônus para palavras-chave importantes
    const palavrasChave = ['ZERO', 'LIGHT', 'SEM ACUCAR', 'SEM AÇÚCAR', 'ZERO LACTOSE', 'DIET'];
    const bonusChave = palavrasChave.filter(p => banco.includes(p) && site.includes(p)).length * 2;

    // Bônus para correspondência exata de sabor (ex: MORANGO)
    const sabores = ['MORANGO', 'LARANJA', 'MAÇA', 'CHOCOLATE', 'BAUNILHA', 'MARACUJA', 'LIMÃO', 'COCO', 'PISTACHE'];
    const saborBanco = sabores.find(s => banco.includes(s));
    const saborSite = sabores.find(s => site.includes(s));
    const bonusSabor = (saborBanco && saborSite && saborBanco === saborSite) ? 2 : 0;

    return Math.round((score * 10) + pesoInicio + bonusChave + bonusSabor);
}

function construirTermoBusca(nomeProduto) {
    const normalizado = normalizarTexto(nomeProduto);
    const palavras = normalizado.split(' ').filter(p => p.length > 2);

    // Tenta extrair marca
    const marcas = ['WICKBOLD','PULLMAN','MELITTA','NESTLE','ACTIVIA','ELMA CHIPS',
                    'SCOTCH BRITE','NATURAL ONE','MOLICO','DANONE','COLGATE','PANCO',
                    'PENSE','BATAVO','VIGOR','PAULISTA','SADIA','PRESIDENT','DOVE',
                    'SEDA','NIVEA','JOHNSON','REXONA','CRF','EMBALIXO','VALGROUP',
                    'ALTACOPPO','CRISTALCOPO','HIGIPACK','PIQUITUCHO','PONJITA',
                    'TIROLEZ','BUFALO','OLIMPO','TUPI','DESTAC','SANOL','DAI',
                    'RADIUM','SWIFT','GRACIANA','ITALAC','ITAMBE','PATO','MINUANO',
                    'YPE','DOWNY','VANISH','VEJA','BRILHANTE','LIMPOL','URCA'];
    let marca = marcas.find(m => normalizado.includes(m));
    let volume = extrairVolume(normalizado);
    let termoParts = [];

    if (marca) termoParts.push(marca);
    let palavrasRestantes = palavras.filter(p => p !== marca);

    // Adiciona palavras-chave (sabor, tipo)
    const chaves = ['ZERO', 'LIGHT', 'DIET', 'SEM ACUCAR', 'INTEGRAL', 'TRADICIONAL'];
    let chaveEncontrada = chaves.find(c => normalizado.includes(c));
    if (chaveEncontrada && !termoParts.includes(chaveEncontrada)) {
        termoParts.push(chaveEncontrada);
        palavrasRestantes = palavrasRestantes.filter(p => p !== chaveEncontrada);
    }

    // Adiciona sabor, se existir
    const sabores = ['MORANGO', 'LARANJA', 'MAÇA', 'CHOCOLATE', 'BAUNILHA', 'MARACUJA', 'LIMÃO', 'COCO', 'PISTACHE', 'FLOCOS'];
    let sabor = sabores.find(s => normalizado.includes(s));
    if (sabor && !termoParts.includes(sabor)) {
        termoParts.push(sabor);
        palavrasRestantes = palavrasRestantes.filter(p => p !== sabor);
    }

    if (volume) {
        const volStr = `${volume.valor}${volume.unidade}`;
        termoParts.push(volStr);
        palavrasRestantes = palavrasRestantes.filter(p => !p.includes(volume.valor.toString()));
    }

    // Adiciona até 3 palavras restantes mais relevantes (as mais longas)
    palavrasRestantes.sort((a,b) => b.length - a.length);
    termoParts.push(...palavrasRestantes.slice(0, 3));

    return termoParts.join(' ');
}

// ============================================================
// 2. FUNÇÃO DE BUSCA COM CACHE E FALLBACKS
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
// 3. FILTRAGEM DO MELHOR MATCH (com score mínimo 2)
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

        if (score >= 2 && marcaBate && volumeBate && multipackBate && score > maiorScore) {
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
                let url = `${configs[loja].host}/api/catalog_system/pub/products/search/${termoEncoded}?_from=0&_to=50`;
                let data = await buscarProdutos(url, loja, termo);

                // Fallback 1: busca com nome completo
                if (!data || data.length === 0) {
                    const termoCompleto = encodeURIComponent(normalizarTexto(prod.nome_comum));
                    url = `${configs[loja].host}/api/catalog_system/pub/products/search/${termoCompleto}?_from=0&_to=50`;
                    data = await buscarProdutos(url, loja, termoCompleto);
                }

                // Fallback 2: busca apenas com marca + palavra-chave (ex: "ACTIVIA MORANGO")
                if (!data || data.length === 0) {
                    const normalizado = normalizarTexto(prod.nome_comum);
                    const marcas = ['WICKBOLD','PULLMAN','MELITTA','NESTLE','ACTIVIA','ELMA CHIPS',
                                    'SCOTCH BRITE','NATURAL ONE','MOLICO','DANONE','COLGATE','PANCO',
                                    'PENSE','BATAVO','VIGOR','PAULISTA','SADIA','PRESIDENT','DOVE',
                                    'SEDA','NIVEA','JOHNSON','REXONA','CRF','EMBALIXO','VALGROUP',
                                    'ALTACOPPO','CRISTALCOPO','HIGIPACK','PIQUITUCHO','PONJITA',
                                    'TIROLEZ','BUFALO','OLIMPO','TUPI','DESTAC','SANOL','DAI',
                                    'RADIUM','SWIFT','GRACIANA','ITALAC','ITAMBE','PATO','MINUANO',
                                    'YPE','DOWNY','VANISH','VEJA','BRILHANTE','LIMPOL','URCA'];
                    let marca = marcas.find(m => normalizado.includes(m));
                    if (marca) {
                        // Pega a primeira palavra significativa após a marca (ex: sabor)
                        let palavras = normalizado.split(' ').filter(p => p.length > 2 && p !== marca);
                        let chave = palavras.length > 0 ? palavras[0] : '';
                        if (chave) {
                            const termoFallback = `${marca} ${chave}`;
                            const fallbackEncoded = encodeURIComponent(termoFallback);
                            url = `${configs[loja].host}/api/catalog_system/pub/products/search/${fallbackEncoded}?_from=0&_to=50`;
                            data = await buscarProdutos(url, loja, termoFallback);
                        }
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