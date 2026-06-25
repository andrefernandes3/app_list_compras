const { MongoClient } = require('mongodb');

// ==================== FUNÇÕES AUXILIARES ====================

// Normalização de texto: remove acentos, caracteres especiais, espaços extras
function normalizarTexto(texto) {
    return texto
        .toUpperCase()
        .normalize('NFD') // separa acentos
        .replace(/[\u0300-\u036f]/g, '') // remove diacríticos
        .replace(/[^A-Z0-9\s]/g, ' ') // troca caracteres especiais por espaço
        .replace(/\s+/g, ' ')
        .trim();
}

// Extração de volume com suporte a diferentes formatos
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

// Comparação de volumes com tolerância de 5%
function volumesCompatíveis(volBanco, volSite) {
    if (!volBanco || !volSite) return true; // se algum não tem, deixa passar (comportamento antigo)
    const numBanco = parseFloat(volBanco);
    const numSite = parseFloat(volSite);
    const unidadeBanco = volBanco.replace(/[\d.]/g, '');
    const unidadeSite = volSite.replace(/[\d.]/g, '');
    if (unidadeBanco !== unidadeSite) return false; // unidades diferentes (ex: G vs ML) não batem
    const tolerancia = 0.05; // 5%
    const diff = Math.abs(numBanco - numSite);
    return diff <= (numBanco * tolerancia);
}

// Detecta se o texto indica multipack (ex: 2 unidades, pacote com 2, kit)
function isMultipack(texto) {
    const normalizado = normalizarTexto(texto);
    return /(PACOTE COM|KIT|CAIXA COM|CX COM|UNIDADES|UN\s*\.|UN\b|\d\s*X\s*\d|\d\s*X\s*[A-Z])/i.test(normalizado) ||
           /\b\d+\s*[Xx]\s*\d+\b/.test(normalizado);
}

// Validação de marca: verifica se a marca do banco está presente no site
function validarMarca(nomeBanco, nomeSite) {
    const marcas = ['WICKBOLD', 'PULLMAN', 'MELITTA', 'NESTLE', 'ACTIVIA', 'ELMA CHIPS', 'SCOTCH BRITE', 'NATURAL ONE', 'MOLICO', 'DANONE', 'COLGATE', 'PANCO'];
    const normalizadoBanco = normalizarTexto(nomeBanco);
    const normalizadoSite = normalizarTexto(nomeSite);

    const marcaBanco = marcas.find(m => normalizadoBanco.includes(m));
    if (!marcaBanco) return true; // sem marca, ignora

    return normalizadoSite.includes(marcaBanco);
}

// Score aprimorado usando Jaccard e peso para palavras iniciais
function calcularScore(nomeBanco, nomeSite) {
    const banco = normalizarTexto(nomeBanco);
    const site = normalizarTexto(nomeSite);

    const palavrasBanco = banco.split(' ').filter(p => p.length > 2);
    const palavrasSite = site.split(' ').filter(p => p.length > 2);

    if (palavrasBanco.length === 0 || palavrasSite.length === 0) return 0;

    // Jaccard simplificado: interseção / união
    const interseccao = palavrasBanco.filter(p => palavrasSite.includes(p));
    const uniao = new Set([...palavrasBanco, ...palavrasSite]);
    const score = uniao.size > 0 ? interseccao.length / uniao.size : 0;

    // Peso extra para palavras que aparecem no início (título)
    const primeirasPalavrasBanco = banco.split(' ').slice(0, 3);
    const primeirasPalavrasSite = site.split(' ').slice(0, 3);
    const pesoInicio = primeirasPalavrasBanco.filter(p => primeirasPalavrasSite.includes(p)).length;

    return Math.round((score * 10) + pesoInicio); // escala de 0 a 10+ 
}

// Construção do termo de busca: usa até 4 palavras relevantes (exclui palavras comuns)
function construirTermoBusca(nomeProduto) {
    const normalizado = normalizarTexto(nomeProduto);
    const palavras = normalizado.split(' ').filter(p => p.length > 2);
    // Pode-se adicionar uma lista de stopwords para melhorar, mas simplificamos
    return palavras.slice(0, 4).join(' ');
}

// Cache simples para respostas da API
const cache = new Map();

// Função para buscar produtos com cache
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

// Filtra o melhor match entre os itens retornados, aplicando todas as regras
function filtrarMelhorMatch(produto, itens) {
    let melhorMatch = null;
    let maiorScore = -1;

    itens.forEach(item => {
        const nomeBanco = produto.nome_comum;
        const nomeSite = item.productName;

        const score = calcularScore(nomeBanco, nomeSite);
        const volumeBanco = extrairVolume(nomeBanco);
        const volumeSite = extrairVolume(nomeSite);
        const volumeBate = volumesCompatíveis(volumeBanco, volumeSite);
        const marcaBate = validarMarca(nomeBanco, nomeSite);
        const multipackBate = isMultipack(nomeBanco) === isMultipack(nomeSite);

        // Só aceita se passar em todas as travas e tiver score mínimo (ajustável)
        if (score >= 3 && marcaBate && volumeBate && multipackBate && score > maiorScore) {
            maiorScore = score;
            melhorMatch = item;
        }
    });
    return melhorMatch;
}

// ==================== FUNÇÃO PRINCIPAL ====================

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
            let resultado = { seu_item: prod.nome_comum, status: "NÃO ENCONTRADO" };
            
            try {
                // Construção do termo de busca
                const termoBase = construirTermoBusca(prod.nome_comum);
                let termo = encodeURIComponent(termoBase);
                let url = `${configs[loja].host}/api/catalog_system/pub/products/search/${termo}?_from=0&_to=20`;
                
                let data = await buscarProdutos(url, loja, termoBase);
                
                // Fallback: se não retornou resultados, tenta com nome completo
                if (!data || data.length === 0) {
                    const termoCompleto = encodeURIComponent(normalizarTexto(prod.nome_comum));
                    url = `${configs[loja].host}/api/catalog_system/pub/products/search/${termoCompleto}?_from=0&_to=20`;
                    data = await buscarProdutos(url, loja, prod.nome_comum); // chave diferente
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