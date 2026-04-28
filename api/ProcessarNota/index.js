const axios = require('axios');
const cheerio = require('cheerio');
const { MongoClient } = require('mongodb');

const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

function limparTexto(texto) {
    if (!texto) return "";
    return texto
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim();
}

module.exports = async function (context, req) {
    const urlNota = req.body && req.body.url;
    const apelidoManual = req.body && req.body.apelido; // Recebe o apelido do frontend

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

        // --- IDENTIFICAÇÃO DO CNPJ ---
        const cnpjBruto = $('.text').text().match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
        const cnpj = cnpjBruto ? cnpjBruto[0] : "00.000.000/0000-00";

        // --- LÓGICA DE APELIDO INTELIGENTE ---
        let nomeFinal;
        if (apelidoManual) {
            nomeFinal = apelidoManual.toUpperCase();
        } else {
            // Busca se já existe um apelido para este CNPJ no histórico
            const notaExistente = await colecao.findOne({ cnpj: cnpj });
            if (notaExistente) {
                nomeFinal = notaExistente.estabelecimento; // Usa o apelido já conhecido
            } else {
                // Se for novo, usa o nome da nota (o frontend tratará de pedir o apelido)
                nomeFinal = $('.txtTopo').first().text().trim() || "Estabelecimento Desconhecido";
            }
        }

        // --- TRATAMENTO DE DATA ---
        const infoGeral = $('.txtCenter').text();
        const dataMatch = infoGeral.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        let dataCompra = dataMatch ? new Date(`${dataMatch[3]}-${dataMatch[2]}-${dataMatch[1]}T12:00:00Z`) : new Date();
        if (isNaN(dataCompra.getTime()) || dataCompra.getFullYear() === 1970) dataCompra = new Date();

        // --- PROCESSAMENTO DE ITENS ---
        const itens = [];
        const linhasItens = $('tr[id^="Item"]').get();

        for (const el of linhasItens) {
            const linha = $(el);
            const texto = linha.text().replace(/\s+/g, ' ');
            const descricaoBruta = linha.find('.txtTit').text().split('\n')[0].trim();
            const idInterno = (texto.match(/Código:\s*([A-Z0-9]+)/i) || [])[1] || "N/A";

            if (descricaoBruta) {
                const vinculo = await db.collection('dicionario_produtos').findOne({ ids_vinculados: idInterno });
                const descricaoFinal = vinculo ? vinculo.nome_comum : limparTexto(descricaoBruta);
                const vTotalItem = parseFloat(linha.find('.valor').text().replace(',', '.')) || 0;

                itens.push({
                    descricao: descricaoFinal,
                    descricao_original: descricaoBruta,
                    id_interno: idInterno,
                    quantidade: parseFloat((texto.match(/Qtde\.:\s*([\d,.]+)/i) || [])[1]?.replace(',', '.') || "0"),
                    unidade: (texto.match(/UN:\s*([A-Z]+)/i) || [])[1] || "UN",
                    preco_unitario: parseFloat((texto.match(/Vl\.\s*Unit\.:\s*([\d,.]+)/i) || [])[1]?.replace(',', '.') || "0"),
                    preco_total: vTotalItem
                });
            }
        }

        let valorTotalNota = parseFloat($('.totalNFe').text().replace(',', '.')) || 
                             parseFloat($('.txtMax').text().replace(',', '.')) || 0;
        if (valorTotalNota === 0) valorTotalNota = itens.reduce((acc, item) => acc + item.preco_total, 0);

        const documento = {
            estabelecimento: nomeFinal,
            cnpj: cnpj,
            data_compra: dataCompra,
            valor_total: parseFloat(valorTotalNota.toFixed(2)),
            itens: itens,
            url_original: urlNota,
            atualizado_em: new Date()
        };

        const resultado = await colecao.updateOne(
            { url_original: urlNota },
            { $set: documento, $setOnInsert: { criado_em: new Date() } },
            { upsert: true }
        );

        context.res = {
            status: 200,
            body: {
                message: "Nota processada!",
                jaConhecido: !!apelidoManual || (await colecao.countDocuments({ cnpj: cnpj })) > 0,
                estabelecimento: nomeFinal,
                cnpj: cnpj,
                dados: documento
            }
        };

    } catch (error) {
        context.res = { status: 500, body: "Erro interno: " + error.message };
    }
};
