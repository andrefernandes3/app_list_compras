const { MongoClient } = require('mongodb');
const nodemailer = require('nodemailer');

module.exports = async function (context, req) {
    let client = new MongoClient(process.env["MONGODB_URI"]);
    
    context.log("DEBUG CONFIGURAÇÃO:", {
    user: process.env.EMAIL_USER ? "DEFINIDO" : "VAZIO",
    pass: process.env.EMAIL_PASS ? "DEFINIDO" : "VAZIO"
});
    // Configuração do Nodemailer usando as variáveis de ambiente do Azure
    const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: process.env.EMAIL_PORT,
        secure: true, // true para 465, false para outras portas
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    try {
        await client.connect();
        const db = client.db('app_compras');
        const alertasCol = db.collection('alertas_preco');

        // Busca alertas pendentes
        const pendentes = await alertasCol.find({ status_notificacao: "pendente" }).toArray();

        if (pendentes.length === 0) {
            context.res = { body: "Nenhum alerta pendente para enviar." };
            return;
        }

        for (const alerta of pendentes) {
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: process.env.EMAIL_USER, // Para você mesmo
                subject: `🚨 Oferta encontrada: ${alerta.produto_nome}`,
                html: `
                    <h2>O produto está barato!</h2>
                    <p><b>Produto:</b> ${alerta.produto_nome}</p>
                    <p><b>Loja:</b> ${alerta.loja}</p>
                    <p><b>Preço Atual:</b> R$ ${alerta.preco_atual}</p>
                    <p><b>Preço Histórico:</b> R$ ${alerta.preco_historico}</p>
                    <br>
                    <a href="${alerta.link_compra}">Clique aqui para comprar</a>
                `
            };

            await transporter.sendMail(mailOptions);
            
            // Marca como enviado
            await alertasCol.updateOne(
                { _id: alerta._id },
                { $set: { status_notificacao: "enviado" } }
            );
        }

        context.res = { body: `Sucesso! ${pendentes.length} e-mails enviados.` };
    } catch (error) {
        context.log.error("Erro no disparo:", error);
        context.res = { status: 500, body: error.message };
    } finally {
        await client.close();
    }
};