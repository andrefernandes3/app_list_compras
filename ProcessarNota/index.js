const axios = require('axios');
const cheerio = require('cheerio');
const { MongoClient } = require('mongodb');

const uri = process.env["MONGODB_URI"]; 
const client = new MongoClient(uri);

module.exports = async function (context, req) {
    const urlNota = req.body && req.body.url;

    if (!urlNota) {
        context.res = { status: 400, body: "URL da nota não fornecida." };
        return;
    }

    try {
        await client.connect();
        const db = client.db('app_compras');
        const colecao = db.collection('historico_precos');

        const { data } = await axios.get(urlNota, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(data);

        // --- EXTRAÇÃO DINÂMICA DO CABEÇALHO ---
        const nomeEstabelecimento = $('.txtTopo').first().text().trim() || "Estabelecimento Desconhecido";
        // Busca o CNPJ no texto, removendo tudo que não é número
        const cnpjBruto = $('.text').text().match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
        const cnpj = cnpjBruto ? cnpjBruto[0] : "00.000.000/0000-00";
        
        // Extração da data de emissão
        const infoGeral = $('.txtCenter').text();
        const dataMatch = infoGeral.match(/(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2})/);
        const dataCompra = dataMatch ? new Date(dataMatch[0].split(' ').reverse().join(' ')) : new Date();

        const itens = [];
        $('tr[id^="Item"]').each((i, el) => {
            const linha = $(el);
            const texto = linha.text().replace(/\s+/g, ' ');
            const descricao = linha.find('.txtTit').text().split('\n')[0].trim();
            
            if (descricao) {
                const vTotalItem = parseFloat(linha.find('.valor').text().replace(',', '.')) || 0;
                itens.push({
                    descricao,
                    id_interno: (texto.match(/Código:\s*([A-Z0-9]+)/i) || [])[1] || "N/A",
                    quantidade: parseFloat((texto.match(/Qtde\.:\s*([\d,.]+)/i) || [])[1]?.replace(',', '.') || "0"),
                    unidade: (texto.match(/UN:\s*([A-Z]+)/i) || [])[1] || "UN",
                    preco_unitario: parseFloat((texto.match(/Vl\.\s*Unit\.:\s*([\d,.]+)/i) || [])[1]?.replace(',', '.') || "0"),
                    preco_total: vTotalItem
                });
            }
        });

        // --- LÓGICA DE VALOR TOTAL ROBUSTA ---
        // 1. Tenta pegar o valor bruto do campo da SEFAZ
        let valorTotalNota = parseFloat($('.totalNFe').text().replace(',', '.')) || 
                             parseFloat($('.txtMax').text().replace(',', '.')) || 0;

        // 2. Fallback: Se o scraper falhou no campo total, somamos os itens
        if (valorTotalNota === 0 && itens.length > 0) {
            valorTotalNota = itens.reduce((acc, item) => acc + item.preco_total, 0);
        }

       // ... (toda a lógica de extração que já validamos)

        const documento = {
            estabelecimento: nomeEstabelecimento,
            cnpj: cnpj,
            data_compra: dataCompra,
            valor_total: parseFloat(valorTotalNota.toFixed(2)),
            itens: itens,
            url_original: urlNota,
            criado_em: new Date()
        };

        const resultado = await colecao.insertOne(documento);

        // AGORA RETORNAMOS O DOCUMENTO PARA O FRONTEND
        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: { 
                message: "Nota processada!", 
                id: resultado.insertedId,
                dados: documento // O Frontend vai ler isso aqui
            }
        };

    } catch (error) {
        context.log("Erro:", error.message);
        context.res = { status: 500, body: "Erro ao processar nota dinâmica." };
    }
};