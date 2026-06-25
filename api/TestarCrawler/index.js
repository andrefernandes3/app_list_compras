const { MongoClient } = require('mongodb');

// Função Juiz: Avalia a similaridade entre o que você busca e o que o site entrega
function calcularScore(nomeBanco, nomeSite) {
    const palavrasBanco = nomeBanco.toUpperCase().split(' ').filter(p => p.length > 2);
    const textoSite = nomeSite.toUpperCase();
    return palavrasBanco.reduce((score, palavra) => textoSite.includes(palavra) ? score + 1 : score, 0);
}

// NOVA TRAVA 1: Conversor Universal de Volumes (Sabe que 1KG = 1000G e 1L = 1000ML)
function extrairVolume(texto) {
    const match = texto.toUpperCase().match(/(\d+(?:[.,]\d+)?)\s*(KG|G|L|ML)/);
    if (!match) return null;
    
    let valor = parseFloat(match[1].replace(',', '.'));
    let unidade = match[2];
    
    // Normaliza tudo para Gramas ou MLs para a comparação ser perfeita
    if (unidade === 'KG') { valor *= 1000; unidade = 'G'; }
    if (unidade === 'L') { valor *= 1000; unidade = 'ML'; }
    
    return `${valor}${unidade}`; // Ex: transforma "1,15KG" em "1150G"
}

// NOVA TRAVA 2: Validador de Marcas
function validarMarca(nomeBanco, nomeSite) {
    const marcas = ['WICKBOLD', 'PULLMAN', 'MELITTA', 'NESTLE', 'ACTIVIA', 'ELMA CHIPS', 'SCOTCH BRITE', 'NATURAL ONE', 'MOLICO', 'DANONE', 'COLGATE', 'PANCO'];
    const marcaBanco = marcas.find(m => nomeBanco.toUpperCase().includes(m));
    
    // Se o seu item tem uma marca mapeada, o site OBRIGATORIAMENTE tem que ter a mesma
    if (marcaBanco) {
        return nomeSite.toUpperCase().includes(marcaBanco);
    }
    return true; // Se não tem marca na lista, deixa passar
}

module.exports = async function (context, req) {
    // Define qual mercado buscar (padrão é SAMS se não informado)
    const loja = (req.query.loja || 'SAMS').toUpperCase();
    
    // ADICIONADO O ATACADÃO AQUI NA CONFIGURAÇÃO
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
                // Motor de Busca Universal VTEX
                const termo = encodeURIComponent(prod.nome_comum.split(' ').slice(0, 2).join(' '));
                const url = `${configs[loja].host}/api/catalog_system/pub/products/search/${termo}?_from=0&_to=20`;
                
                const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                const data = res.ok ? await res.json() : [];
                
                if (data && data.length > 0) {
                    let melhorMatch = null;
                    let maiorScore = -1;

                    data.forEach(item => {
                        const nomeBanco = prod.nome_comum;
                        const nomeSite = item.productName;

                        const score = calcularScore(nomeBanco, nomeSite);
                        
                        // Executa as Travas
                        const volumeBanco = extrairVolume(nomeBanco);
                        const volumeSite = extrairVolume(nomeSite);
                        const volumeBate = (volumeBanco && volumeSite) ? volumeBanco === volumeSite : true;
                        
                        const marcaBate = validarMarca(nomeBanco, nomeSite);

                        // NOVA TRAVA 3: Proteção contra Kits/Multipacks (ex: 2x500g)
                        const isMultipackSite = /CAIXA COM|PACK|\dX/i.test(nomeSite);
                        const isMultipackBanco = /CAIXA COM|PACK|\dX/i.test(nomeBanco);
                        const multipackBate = isMultipackBanco === isMultipackSite;

                        // Só aceita se passar em TODAS as travas e tiver score mínimo
                        if (score >= 2 && marcaBate && volumeBate && multipackBate && score > maiorScore) {
                            maiorScore = score;
                            melhorMatch = item;
                        }
                    });

                    if (melhorMatch) {
                        const oferta = melhorMatch.items[0].sellers[0].commertialOffer;
                        resultado = { 
                            seu_item: prod.nome_comum, 
                            item_oficial_site: melhorMatch.productName,
                            nota_de_precisao: maiorScore,
                            preco_site: oferta.Price, 
                            status: oferta.Price > 0 ? "ENCONTRADO" : "SEM ESTOQUE" 
                        };
                    }
                }
            } catch (e) { context.log(`Erro em ${prod.nome_comum}:`, e.message); }
            
            relatorio.resultados.push(resultado);
        }
        context.res = { status: 200, body: relatorio };
    } catch (e) {
        context.res = { status: 500, body: { erro: e.message } };
    } finally {
        if (client) await client.close();
    }
};
