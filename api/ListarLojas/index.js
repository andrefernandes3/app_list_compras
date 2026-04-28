// Esta API apenas retorna os nomes únicos das lojas para o seu filtro
const lojas = await db.collection('historico_precos').distinct("estabelecimento");
context.res = { body: lojas };
