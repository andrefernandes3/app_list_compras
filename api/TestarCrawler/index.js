const { MongoClient } = require('mongodb');

// ============================================================
// 1. FUNÇÕES AUXILIARES DE NORMALIZAÇÃO E EXTRAÇÃO
// ============================================================

// Normaliza texto: maiúsculas, remove acentos, caracteres especiais e espaços extras
function normalizarTexto(texto) {
    return texto
        .toUpperCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Extrai volume com suporte a várias grafias (1,5kg, 1500ML, 1.5 L, 1.5 litros)
function extrairVolume(texto) {
    const normalizado = normalizarTexto(texto);
    // Padrão: número (com vírgula ou ponto) + possível espaço + unidade (kg, g, l, ml, litro, grama)
    const match = normalizado.match(/(\d+[.,]?\d*)\s*(KG|G|L|ML|LITROS|GRAMAS)/);
    if (!match) return null;

    let valor = parseFloat(match[1].replace(',', '.'));
    let unidade = match[2];

    // Mapear sinônimos
    if (unidade === 'LITROS') unidade = 'L';
    if (unidade === 'GRAMAS') unidade = 'G';

    // Normaliza para base (G ou ML)
    if (unidade === 'KG') { valor *= 1000; unidade = 'G'; }
    if (unidade === 'L')  { valor *= 1000; unidade = 'ML'; }

    return `${Math.round(valor)}${unidade}`; // arredonda para evitar floats
}

// Compara volumes com tolerância de 5%
function volumesCompativeis(volBanco, volSite) {
    if (!volBanco || !volSite) return true; // se algum não tem, deixa passar
    const numBanco = parseFloat(volBanco);
    const numSite = parseFloat(volSite);
    const unidadeBanco = volBanco.replace(/[\d.]/g, '');
    const unidadeSite = volSite.replace(/[\d.]/g, '');
    if (unidadeBanco !== unidadeSite) return false; // unidades diferentes
    const tolerancia = 0.05; // 5%
    const diff = Math.abs(numBanco - numSite);
    return diff <= (numBanco * tolerancia);
}

// Detecta se o produto é um multipack (kit, caixa com, unidades, etc.)
function isMultipack(texto) {
    const normalizado = normalizarTexto(texto);
    return /(PACOTE COM|KIT|CAIXA COM|CX COM|UNIDADES|UN\s*\.|UN\b|\d\s*[Xx]\s*\d|\d\s*[Xx]\s*[A-Z])/.test(normalizado);
}

// Validação de marca: se o banco tem uma marca conhecida, o site deve conter a mesma
function validarMarca(nomeBanco, nomeSite) {
    const marcas = ['WICKBOLD', 'PULLMAN', 'MELITTA', 'NESTLE', 'ACTIVIA', 'ELMA CHIPS', 
                    'SCOTCH BRITE', 'NATURAL ONE', 'MOLICO', 'DANONE', 'COLGATE', 'PANCO'];
    const normalizadoBanco = normalizarTexto(nomeBanco);
    const normalizadoSite = normalizarTexto(nomeSite);

    const marcaBanco = marcas.find(m => normalizadoBanco.includes(m));
    if (!marcaBanco) return true; // sem marca, ignora

    return normalizadoSite.includes(marcaBanco);
}

// Score aprimorado: usa similaridade de Jaccard + peso para palavras iniciais
function calcularScore(nomeBanco, nomeSite) {
    const banco = normalizarTexto(nomeBanco);
    const site = normalizarTexto(nomeSite);

    const palavrasBanco = banco.split(' ').filter(p => p.length > 2);
    const palavrasSite = site.split(' ').filter(p => p.length > 2);

    if (palavrasBanco.length === 0 || palavrasSite.length === 0) return 0;

    // Jaccard simplificado
    const interseccao = palavrasBanco.filter(p => palavrasSite.includes(p));
    const uniao = new Set([...palavrasBanco, ...palavrasSite]);
    let score = uniao.size > 0 ? interseccao.length / uniao.size : 0;

    // Peso extra para as 3 primeiras palavras (título)
    const primeirasBanco = banco.split(' ').slice(0, 3);
    const primeirasSite = site.split(' ').slice(0, 3);
    const pesoInicio = primeirasBanco.filter(p => primeirasSite.includes(p)).length;

    // Escala de 0 a 10+ 
    return Math.round((score * 10) + pesoInicio);
}

// Constroi termo de busca usando palavras mais relevantes (até 4)
function construirTermoBusca(nomeProduto) {
    const normalizado = normalizarTexto(nomeProduto);
    const palavras = normalizado.split(' ').filter(p => p.length > 2);
    // Pega até 4 palavras mais significativas (pode ser melhorado)
    return palavras.slice(0, 4).join(' ');
}

// ============================================================
// 2. FUNÇÃO DE BUSCA COM CACHE
// ============================================================

const cache = new Map();

async function buscarProdutos(url, loja, termo) {
    const chave = `${loja}:${termo}`;
    if (cache.has(chave)) return cache.get(chave);
    try {
        const res = await fetch(url, { 
            headers: { 'User-Agent': 'Mozilla/5.0' } 
        });
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

        // Critérios de aceitação: score mínimo 3, e todas as travas verdadeiras
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
    // Define qual mercado buscar (padrão é SAMS se não informado)
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
                // Construção do termo de busca
                const termo = construirTermoBusca(prod.nome_comum);
                const termoEncoded = encodeURIComponent(termo);
                let url = `${configs[loja].host}/api/catalog_system/pub/products/search/${termoEncoded}?_from=0&_to=20`;
                
                // Primeira tentativa de busca
                let data = await buscarProdutos(url, loja, termo);
                
                // Fallback: se não encontrou nada, busca com nome completo
                if (!data || data.length === 0) {
                    const termoCompleto = encodeURIComponent(normalizarTexto(prod.nome_comum));
                    url = `${configs[loja].host}/api/catalog_system/pub/products/search/${termoCompleto}?_from=0&_to=20`;
                    data = await buscarProdutos(url, loja, termoCompleto);
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