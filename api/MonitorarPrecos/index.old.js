const { MongoClient } = require('mongodb');

// ============================================================
// 1. FUNÇÕES AUXILIARES DE NORMALIZAÇÃO E EXTRAÇÃO
// ============================================================

function normalizarTexto(texto) {
    return texto.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
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

function volumesCompativeis(volBanco, volSite) {
    if (!volBanco || !volSite) return true;
    let { valor: v1, unidade: u1 } = volBanco;
    let { valor: v2, unidade: u2 } = volSite;

    if (u1 === 'ML' && u2 === 'G') v2 = v2; 
    else if (u1 === 'G' && u2 === 'ML') v1 = v1;
    else if (u1 !== u2) return false;

    const tolerancia = 0.05; 
    const diff = Math.abs(v1 - v2);
    return diff <= (v1 * tolerancia);
}

function isMultipack(texto) {
    const normalizado = normalizarTexto(texto);
    return /(PACOTE COM|KIT|CAIXA COM|CX COM|UNIDADES|UN\s*\.|UN\b|\d\s*[Xx]\s*\d|\d\s*[Xx]\s*[A-Z])/.test(normalizado);
}

function validarMarca(nomeBanco, nomeSite) {
    const marcas = [
        'WICKBOLD', 'PULLMAN', 'MELITTA', 'NESTLE', 'ACTIVIA', 'ELMA CHIPS',
        'SCOTCH BRITE', 'NATURAL ONE', 'MOLICO', 'DANONE', 'COLGATE', 'PANCO',
        'PENSE', 'BATAVO', 'VIGOR', 'PAULISTA', 'SADIA', 'PRESIDENT', 'DOVE',
        'SEDA', 'NIVEA', 'JOHNSON', 'REXONA', 'CRF', 'EMBALIXO', 'VALGROUP',
        'ALTACOPPO', 'CRISTALCOPO', 'HIGIPACK', 'PIQUITUCHO', 'PONJITA',
        'ITAMBE', 'BRILHANTE', 'SWIFT', 'VEJA', 'LIMPOL', 'TIROLEZ', 'YOKA', 
        'DOWNY', 'VANISH', 'SANOL', 'MEMBER', 'COCA'
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

    const palavrasChave = ['ZERO', 'LIGHT', 'SEM ACUCAR', 'SEM AÇÚCAR'];
    const bonusChave = palavrasChave.filter(p => banco.includes(p) && site.includes(p)).length * 2;

    return Math.round((score * 10) + pesoInicio + bonusChave);
}

function construirTermoBusca(nomeProduto) {
    const normalizado = normalizarTexto(nomeProduto);
    const palavras = normalizado.split(' ').filter(p => p.length > 2);
    const marcas = ['WICKBOLD','PULLMAN','MELITTA','NESTLE','ACTIVIA','ELMA CHIPS','SCOTCH BRITE','NATURAL ONE','MOLICO','DANONE','COLGATE','PANCO','PENSE','BATAVO','VIGOR','PAULISTA','SADIA','PRESIDENT','DOVE','SEDA','NIVEA','JOHNSON','REXONA','CRF','EMBALIXO','VALGROUP','ALTACOPPO','CRISTALCOPO','HIGIPACK','PIQUITUCHO','PONJITA','ITAMBE','BRILHANTE','SWIFT','VEJA','LIMPOL','TIROLEZ','YOKA','DOWNY','VANISH','SANOL','MEMBER','COCA'];
    let marca = marcas.find(m => normalizado.includes(m));
    let volume = extrairVolume(normalizado);
    let termoParts = [];

    if (marca) termoParts.push(marca);
    let palavrasRestantes = palavras.filter(p => p !== marca);
    if (volume) {
        const volStr = `${volume.valor}${volume.unidade}`;
        termoParts.push(volStr);
        palavrasRestantes = palavrasRestantes.filter(p => !p.includes(volume.valor.toString()));
    }
    termoParts.push(...palavrasRestantes.slice(0, 5 - termoParts.length));
    return termoParts.join(' ');
}

// ============================================================
// 2. FUNÇÕES DE BANCO DE DADOS E CACHE
// ============================================================

async function obterMenorPrecoHistorico(db, nomeProduto) {
    const primeiraPalavra = nomeProduto.split(' ')[0];
    const pipeline = [
        { $unwind: "$itens" },
        { $match: { "itens.descricao": { $regex: primeiraPalavra, $options: 'i' } } },
        { $group: { _id: null, menorPreco: { $min: "$itens.preco_unitario" } } }
    ];
    const cursor = await db.collection("historico_precos").aggregate(pipeline).toArray();
    return cursor.length > 0 ? cursor[0].menorPreco : Infinity;
}

const cache = new Map();

async function buscarProdutos(url, loja, termo) {
    const chave = `${loja}:${termo}`;
    if (cache.has(chave)) return cache.get(chave);
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = res.ok ? await res.json() : [];
        cache.set(chave, data);
        return data;
    } catch (e) { return []; }
}

function filtrarMelhorMatch(produto, itens) {
    let melhorMatch = null;
    let maiorScore = -1;

    itens.forEach(item => {
        const nomeBanco = produto.nome_comum;
        const nomeSite = item.productName;
        const score = calcularScore(nomeBanco, nomeSite);
        const volumeBate = volumesCompativeis(extrairVolume(nomeBanco), extrairVolume(nomeSite));
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
// 3. FUNÇÃO PRINCIPAL (AZURE FUNCTION)
// ============================================================

module.exports = async function (context, req) {
    const configs = [
        { id: 'SAMS', nome: "Sam's Club", host: 'https://www.samsclub.com.br' },
        { id: 'CARREFOUR', nome: "Carrefour", host: 'https://www.carrefour.com.br' },
        { id: 'ATACADAO', nome: "Atacadão", host: 'https://www.atacadao.com.br' }
    ];

    let client = null;
    let relatorioVarredura = []; // ARRAY QUE VAI MOSTRAR TUDO NA TELA

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
            const precoReferencia = prod.preco_alvo || menorPrecoHistorico;
            
            if (precoReferencia === Infinity) continue;

            for (const lojaConfig of configs) {
                try {
                    const termo = construirTermoBusca(prod.nome_comum);
                    let url = `${lojaConfig.host}/api/catalog_system/pub/products/search/${encodeURIComponent(termo)}?_from=0&_to=20`;
                    let data = await buscarProdutos(url, lojaConfig.id, termo);

                    if (!data || data.length === 0) {
                        const vol = extrairVolume(prod.nome_comum);
                        const marca = normalizarTexto(prod.nome_comum).split(' ')[0];
                        if (marca && vol) {
                            const termoFallback = `${marca} ${vol.valor}${vol.unidade}`;
                            url = `${lojaConfig.host}/api/catalog_system/pub/products/search/${encodeURIComponent(termoFallback)}?_from=0&_to=20`;
                            data = await buscarProdutos(url, lojaConfig.id, termoFallback);
                        }
                    }

                    if (data && data.length > 0) {
                        const melhorMatch = filtrarMelhorMatch(prod, data);
                        
                        if (melhorMatch) {
                            const precoAtual = melhorMatch.items[0].sellers[0].commertialOffer.Price;
                            let statusAcao = "Preço Normal/Alto (Ignorado)";

                            if (precoAtual < precoReferencia && precoAtual > 0) {
                                const alertaExistente = await alertasCol.findOne({
                                    produto_nome: prod.nome_comum, loja: lojaConfig.nome, preco_atual: precoAtual, status_notificacao: "pendente"
                                });

                                if (!alertaExistente) {
                                    await alertasCol.insertOne({
                                        produto_nome: prod.nome_comum, loja: lojaConfig.nome, preco_historico: precoReferencia, preco_atual: precoAtual, link_compra: melhorMatch.link, data_alerta: new Date(), status_notificacao: "pendente"
                                    });
                                    totalAlertas++;
                                    statusAcao = "🚨 ALERTA SALVO NA FILA!";
                                } else {
                                    statusAcao = "⏳ Alerta já estava pendente na fila";
                                }
                            }

                            // Registra o que ele encontrou e a decisão que tomou
                            relatorioVarredura.push({
                                produto_buscado: prod.nome_comum,
                                loja: lojaConfig.nome,
                                alvo_ou_historico: precoReferencia,
                                preco_site: precoAtual,
                                status_da_varredura: statusAcao
                            });

                        } else {
                            relatorioVarredura.push({ produto_buscado: prod.nome_comum, loja: lojaConfig.nome, status_da_varredura: "Item rejeitado pelas Travas de Segurança" });
                        }
                    } else {
                        relatorioVarredura.push({ produto_buscado: prod.nome_comum, loja: lojaConfig.nome, status_da_varredura: "Sem estoque no site" });
                    }
                } catch (e) {
                    relatorioVarredura.push({ produto_buscado: prod.nome_comum, loja: lojaConfig.nome, status_da_varredura: `ERRO: ${e.message}` });
                }
            }
        }
        
        // CUSPINDO O RELATÓRIO NO NAVEGADOR
        context.res = { 
            status: 200, 
            body: { 
                mensagem: "Varredura 100% finalizada.", 
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