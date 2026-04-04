const axios = require('axios');
const cheerio = require('cheerio');
const { MongoClient } = require('mongodb');

// 1. CONFIGURAÇÃO (Troque pela sua string do Atlas)
const uri = "mongodb://10inh01985_db_user:FoUW2KZUpenYFTua@ac-l2zuwfs-shard-00-00.nwnuvic.mongodb.net:27017/E-Learning-Training?authSource=admin&ssl=true";
const client = new MongoClient(uri);

async function processarESalvar(urlNota) {
    try {
        console.log("Conectando ao MongoDB Atlas...");
        await client.connect();
        const db = client.db('app_compras');
        const colecao = db.collection('historico_precos');

        console.log("Lendo nota da SEFAZ...");
        const { data } = await axios.get(urlNota, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(data);

        const itens = [];
        $('tr[id^="Item"]').each((i, el) => {
            const linha = $(el);
            const texto = linha.text().replace(/\s+/g, ' ');
            
            const descricao = linha.find('.txtTit').text().split('\n')[0].trim();
            const idInterno = (texto.match(/Código:\s*([A-Z0-9]+)/i) || [])[1] || "N/A";
            const qtd = (texto.match(/Qtde\.:\s*([\d,.]+)/i) || [])[1]?.replace(',', '.') || "0";
            const vUnit = (texto.match(/Vl\.\s*Unit\.:\s*([\d,.]+)/i) || [])[1]?.replace(',', '.') || "0";
            const vTotal = linha.find('.valor').text().replace(',', '.');

            if (descricao) {
                itens.push({
                    descricao,
                    id_interno: idInterno,
                    quantidade: parseFloat(qtd),
                    preco_unitario: parseFloat(vUnit),
                    preco_total: parseFloat(vTotal),
                    data_compra: new Date("2026-04-01") // O ideal é extrair da nota, mas fixamos para teste
                });
            }
        });

        const documento = {
            estabelecimento: "WMS SUPERMERCADOS - OSASCO",
            cnpj: "93.209.765/0637-04",
            data_registro: new Date(),
            itens: itens
        };

        const resultado = await colecao.insertOne(documento);
        console.log(`✅ Nota salva com sucesso! ID: ${resultado.insertedId}`);

    } catch (err) {
        console.error("❌ Erro:", err.message);
    } finally {
        await client.close();
    }
}

// URL que você me enviou
const urlTeste = 'https://www.nfce.fazenda.sp.gov.br/qrcode?p=35260493209765063704655380000183001048579170|2|1|1|A15DA0C21A33275D14CA92CE8D936DFB45E7A136';
processarESalvar(urlTeste);