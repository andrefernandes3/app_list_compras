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

        // --- BLOCO CORRIGIDO: TRATAMENTO DE DATA ---
        const infoGeral = $('.txtCenter').text();
        const dataMatch = infoGeral.match(/(\d{2})\/(\d{2})\/(\d{4})/); // Pega DD, MM e AAAA

        let dataCompra;
        if (dataMatch) {
            // Monta no formato AAAA-MM-DD que o JavaScript entende perfeitamente
            const [_, dia, mes, ano] = dataMatch;
            dataCompra = new Date(`${ano}-${mes}-${dia}T12:00:00Z`);
        } else {
            dataCompra = new Date(); // Se falhar, usa a data de hoje para não ficar 1970
        }

        // Caso a data ainda resulte em algo inválido ou 1970, força a data atual
        if (isNaN(dataCompra.getTime()) || dataCompra.getFullYear() === 1970) {
            dataCompra = new Date();
        }
        // -------------------------------------------

        const itens = [];
        const linhasItens = $('tr[id^="Item"]').get();

        for (const el of linhasItens) {
            const linha = $(el);
            const texto = linha.text().replace(/\s+/g, ' ');

            const descricaoBruta = linha.find('.txtTit').text().split('\n')[0].trim();
            const idInterno = (texto.match(/Código:\s*([A-Z0-9]+)/i) || [])[1] || "N/A";

            if (descricaoBruta) {
                const vinculo = await db.collection('dicionario_produtos').findOne({
                    ids_vinculados: idInterno
                });

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
            atualizado_em: new Date()
        };

        const resultado = await colecao.updateOne(
            { url_original: urlNota }, // Busca por esta URL
            {
                $set: documento,
                $setOnInsert: { criado_em: new Date() } // Só cria a data de criação se for novo
            },
            { upsert: true } // Se não existir, cria; se existir, atualiza
        );

        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: {
                message: "Nota processada e sincronizada!",
                upsertedId: resultado.upsertedId,
                dados: documento
            }
        };

    } catch (error) {
        context.log("Erro:", error.message);
        context.res = { status: 500, body: "Erro interno: " + error.message };
    }
};