const axios = require('axios');
const cheerio = require('cheerio');
const { MongoClient } = require('mongodb');

const uri = process.env["MONGODB_URI"];
const client = new MongoClient(uri);

// 1. Movemos a função para fora para ficar organizada
function limparTexto(texto) {
    if (!texto) return "";
    return texto
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Remove acentos
        .trim();
}

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

        const nomeEstabelecimento = $('.txtTopo').first().text().trim() || "Estabelecimento Desconhecido";
        const cnpjBruto = $('.text').text().match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
        const cnpj = cnpjBruto ? cnpjBruto[0] : "00.000.000/0000-00";

        const infoGeral = $('.txtCenter').text();
        const dataMatch = infoGeral.match(/(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2})/);
        const dataCompra = dataMatch ? new Date(dataMatch[0].split(' ').reverse().join(' ')) : new Date();

        const itens = [];
        $('tr[id^="Item"]').each((i, el) => {
            const linha = $(el);
            const texto = linha.text().replace(/\s+/g, ' ');
            
            // 2. Pegamos a descrição original primeiro
            const descricaoBruta = linha.find('.txtTit').text().split('\n')[0].trim();

            if (descricaoBruta) {
                // 3. AGORA SIM, usamos a função limparTexto com a variável correta
                const descricaoFinal = limparTexto(descricaoBruta);
                
                const vTotalItem = parseFloat(linha.find('.valor').text().replace(',', '.')) || 0;
                
                itens.push({
                    descricao: descricaoFinal, // Salva o nome limpo
                    descricao_original: descricaoBruta, // Mantém o original para referência
                    id_interno: (texto.match(/Código:\s*([A-Z0-9]+)/i) || [])[1] || "N/A",
                    quantidade: parseFloat((texto.match(/Qtde\.:\s*([\d,.]+)/i) || [])[1]?.replace(',', '.') || "0"),
                    unidade: (texto.match(/UN:\s*([A-Z]+)/i) || [])[1] || "UN",
                    preco_unitario: parseFloat((texto.match(/Vl\.\s*Unit\.:\s*([\d,.]+)/i) || [])[1]?.replace(',', '.') || "0"),
                    preco_total: vTotalItem
                });
            }
        });

        let valorTotalNota = parseFloat($('.totalNFe').text().replace(',', '.')) ||
                             parseFloat($('.txtMax').text().replace(',', '.')) || 0;

        if (valorTotalNota === 0 && itens.length > 0) {
            valorTotalNota = itens.reduce((acc, item) => acc + item.preco_total, 0);
        }

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

        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: {
                message: "Nota processada!",
                id: resultado.insertedId,
                dados: documento
            }
        };

    } catch (error) {
        context.log("Erro:", error.message);
        context.res = { status: 500, body: "Erro interno: " + error.message };
    }
};