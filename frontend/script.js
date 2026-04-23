let totaisPorMercado = {};
let itensSelecionados = new Set();

function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/'/g, "\\'");
}

function ampliarImagem(url, nome) {
    if (!url || url.includes('placeholder')) return;
    const modalHtml = `
            <div id="modal-foto" onclick="this.remove()" class="fixed inset-0 bg-black/90 z-[60] flex items-center justify-center p-4">
                <div class="relative w-full max-w-sm"> 
                    <img src="${url}" class="w-full h-auto max-h-[70vh] object-contain rounded-2xl shadow-2xl border-4 border-white/10">
                    <p class="text-white text-center mt-4 font-bold uppercase tracking-widest text-[10px]">${nome}</p>
                </div>
            </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function alternarAba(aba) {
    const isLista = aba === 'lista';
    document.getElementById('secao-lista').classList.toggle('hidden', !isLista);
    document.getElementById('secao-dicionario').classList.toggle('hidden', isLista);
    document.getElementById('btn-aba-lista').className = isLista ? "flex-1 py-3 text-sm font-bold border-b-2 border-blue-600 text-blue-600" : "flex-1 py-3 text-sm font-bold text-gray-500";
    document.getElementById('btn-aba-dict').className = !isLista ? "flex-1 py-3 text-sm font-bold border-b-2 border-blue-600 text-blue-600" : "flex-1 py-3 text-sm font-bold text-gray-500";
    if (isLista) carregarLista(); else renderizarDicionario();
}

async function carregarLista() {
    totaisPorMercado = {};
    const listaDiv = document.getElementById('lista-ativa');
    listaDiv.innerHTML = '<p class="text-gray-400 text-xs text-center animate-pulse">Sincronizando...</p>';

    try {
        const response = await fetch('/api/GerenciarLista');
        const itens = await response.json();
        const respDict = await fetch('/api/VincularProdutos');
        const dicionario = await respDict.json();

        if (itens.length === 0) {
            listaDiv.innerHTML = '<p class="text-gray-500 italic text-center py-4">Tudo pronto! 🎉</p>';
            document.getElementById('totalizador-estimado').classList.add('hidden');
            return;
        }

        listaDiv.innerHTML = '';
        itens.forEach(item => {
            const infoDict = dicionario.find(p => p.nome_comum === item.item_nome) || {};
            const idFormatado = item.item_nome.replace(/\s+/g, '-');
            const nomeSeguro = escapeHTML(item.item_nome);
            const fotoUrl = infoDict.foto_url || 'https://via.placeholder.com/50';
            const qtd = item.quantidade || 1;
            const statusComprado = item.comprado || false;

            const itemElement = document.createElement('div');
            // Aplica a classe visual se estiver comprado
            itemElement.className = `bg-white p-2 rounded-xl border border-blue-50 shadow-sm mb-2 flex items-center gap-3 ${statusComprado ? 'item-comprado' : ''}`;

            itemElement.innerHTML = `
                <div class="w-12 h-12 shrink-0 overflow-hidden rounded-lg border border-gray-100 bg-gray-50">
                    <img src="${fotoUrl}" onclick="ampliarImagem('${fotoUrl}', '${nomeSeguro}')" 
                         class="w-full h-full object-cover cursor-zoom-in" onerror="this.src='https://via.placeholder.com/50'">
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex justify-between items-start">
                        <span onclick="abrirGrafico('${nomeSeguro}')" 
                            class="font-bold text-gray-700 uppercase text-[10px] cursor-pointer underline decoration-blue-300 break-words line-clamp-2 pr-1 texto-item">
                            ${item.item_nome}
                        </span>
                        <div class="flex items-center gap-1 bg-blue-50 p-1 rounded-lg">
                            <button onclick="ajustarQtdLista('${nomeSeguro}', ${qtd - 1})" class="w-5 h-5 flex items-center justify-center bg-white rounded border border-blue-200 text-blue-600 font-bold">-</button>
                            <span class="text-[10px] font-black text-blue-700 w-4 text-center">${qtd}</span>
                            <button onclick="ajustarQtdLista('${nomeSeguro}', ${qtd + 1})" class="w-5 h-5 flex items-center justify-center bg-white rounded border border-blue-200 text-blue-600 font-bold">+</button>
                            
                            <button onclick="alternarStatus('${nomeSeguro}', ${!statusComprado})" class="text-lg ml-1 shrink-0">
                                ${statusComprado ? '🔄' : '✅'}
                            </button>
                        </div>
                    </div>
                    <div id="preco-lista-${idFormatado}"></div>
                </div>
            `;
            listaDiv.appendChild(itemElement);

            // Dispara a busca de preços para cada item (Valor unitário x Qtd)
            buscarComparativo(item.item_nome, qtd, document.getElementById(`preco-lista-${idFormatado}`));
        });
    } catch (err) { console.error(err); }
}

// Nova função para lidar com o status reverso
async function alternarStatus(nome, novoStatus) {
    try {
        await fetch('/api/GerenciarLista', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: nome.toUpperCase(), comprado: novoStatus })
        });
        carregarLista(); // Recarrega para aplicar o visual
    } catch (e) { console.error(e); }
}

async function ajustarQtdLista(nome, novaQtd) {
    if (novaQtd < 1) return;
    try {
        await fetch('/api/GerenciarLista', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: nome.toUpperCase(), quantidade: novaQtd })
        });
        carregarLista();
    } catch (e) { console.error(e); }
}

async function renderizarDicionario() {
    const container = document.getElementById('lista-dicionario');
    container.innerHTML = '<p class="text-center text-gray-400">Carregando...</p>';
    itensSelecionados.clear();
    document.getElementById('btn-adicionar-multiplos').classList.add('hidden');
    document.getElementById('select-all-dict').checked = false;

    try {
        const response = await fetch('/api/VincularProdutos');
        const produtos = await response.json();
        const categorias = {};
        produtos.forEach(p => {
            const cat = p.categoria || "OUTROS";
            if (!categorias[cat]) categorias[cat] = [];
            categorias[cat].push(p);
        });

        container.innerHTML = '';
        for (const [cat, itens] of Object.entries(categorias)) {
            const div = document.createElement('div');
            div.className = "mb-4";
            div.innerHTML = `<h3 class="text-[10px] font-black text-blue-500 mb-2 uppercase tracking-widest border-l-4 border-blue-500 pl-2">${cat}</h3>`;
            itens.forEach(prod => {
                const fotoUrl = prod.foto_url || 'https://via.placeholder.com/50';
                const nomeSeguro = escapeHTML(prod.nome_comum);
                div.innerHTML += `
                            <div class="bg-white p-2 rounded-xl border border-gray-100 flex items-center mb-1 shadow-sm gap-3">
                                <input type="checkbox" data-nome="${nomeSeguro}" onchange="toggleSelecao('${nomeSeguro}', this.checked)" class="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500">
                                <div class="w-10 h-10 shrink-0 overflow-hidden rounded-lg bg-gray-50">
                                    <img src="${fotoUrl}" onclick="ampliarImagem('${fotoUrl}', '${nomeSeguro}')" class="w-full h-full object-cover">
                                </div>
                                <div class="flex-1"><p class="text-[10px] font-bold text-gray-800 uppercase">${prod.nome_comum}</p></div>
                                <button onclick="adicionarDiretoALista('${nomeSeguro}')" class="bg-blue-50 text-blue-600 px-3 py-2 rounded-lg text-xs font-bold active:scale-90">🛒+</button>
                            </div>`;
            });
            container.appendChild(div);
        }
    } catch (e) { }
}

function selecionarTudoDicionario(checked) {
    const checkboxes = document.querySelectorAll('#lista-dicionario input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.checked = checked;
        const nome = cb.getAttribute('data-nome');
        if (checked) itensSelecionados.add(nome);
        else itensSelecionados.delete(nome);
    });
    atualizarBotaoMultiplos();
}

function toggleSelecao(nome, checked) {
    if (checked) itensSelecionados.add(nome);
    else itensSelecionados.delete(nome);
    atualizarBotaoMultiplos();
}

function atualizarBotaoMultiplos() {
    const btn = document.getElementById('btn-adicionar-multiplos');
    const contador = itensSelecionados.size;
    if (contador > 0) {
        btn.classList.remove('hidden');
        btn.innerText = `ADICIONAR ${contador} ITENS`;
    } else {
        btn.classList.add('hidden');
    }
}

async function enviarSelecionadosParaLista() {
    const btn = document.getElementById('btn-adicionar-multiplos');
    btn.innerText = "ADICIONANDO...";
    btn.disabled = true;

    for (let nome of itensSelecionados) {
        await fetch('/api/GerenciarLista', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: nome.toUpperCase(), quantidade: 1 })
        });
    }
    alert(`${itensSelecionados.size} itens adicionados!`);
    alternarAba('lista');
}

async function buscarComparativo(nomeProduto, quantidade, elementoDestino) {
    try {
        const response = await fetch(`/api/CompararPrecos?nome=${encodeURIComponent(nomeProduto)}`);
        if (!response.ok) return;
        const dados = await response.json();
        if (dados.length > 0) {
            const melhor = dados[0];
            const mercado = melhor._id.split(' ')[0];
            const subtotal = melhor.menorPreco * quantidade;
            if (!totaisPorMercado[mercado]) totaisPorMercado[mercado] = 0;
            totaisPorMercado[mercado] += subtotal;
            elementoDestino.innerHTML = `
                        <div class="mt-1 text-[9px] bg-green-50 text-green-700 p-1 px-2 rounded-lg border border-green-100 flex justify-between items-center italic">
                            <span>💡 ${mercado}</span>
                            <span class="font-bold">R$ ${melhor.menorPreco.toFixed(2)} x ${quantidade} = R$ ${subtotal.toFixed(2)}</span>
                        </div>`;
            atualizarSomaVisual();
        } else {
            elementoDestino.innerHTML = `<div class="text-[9px] text-gray-400 italic">🔍 Sem histórico</div>`;
        }
    } catch (e) { }
}

function atualizarSomaVisual() {
    const container = document.getElementById('mercados-soma');
    document.getElementById('totalizador-estimado').classList.remove('hidden');
    container.innerHTML = '';
    Object.entries(totaisPorMercado).sort((a, b) => a[1] - b[1]).forEach(([m, v], i) => {
        const cor = i === 0 ? 'bg-green-100 border-green-200 text-green-700' : 'bg-gray-50 border-gray-200 text-gray-500';
        container.innerHTML += `<div class="p-2 rounded-lg border ${cor} text-center shadow-sm"><p class="text-[8px] uppercase">${m}</p><p class="text-xs font-bold">R$ ${v.toFixed(2)}</p></div>`;
    });
}

async function marcarComoComprado(nome) {
    try {
        await fetch('/api/GerenciarLista', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: nome.toUpperCase(), comprado: true })
        });
        carregarLista();
    } catch (e) { }
}

async function adicionarItemManual() {
    const inputNome = document.getElementById('novo-item-lista');
    const inputQtd = document.getElementById('qtd-item-lista');
    const nome = inputNome.value.trim().toUpperCase();
    const quantidade = parseFloat(inputQtd.value) || 1;
    if (!nome) return;
    await fetch('/api/GerenciarLista', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: nome, quantidade: quantidade })
    });
    inputNome.value = ''; inputQtd.value = '1';
    carregarLista();
}

async function adicionarDiretoALista(nome) {
    await fetch('/api/GerenciarLista', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: nome.toUpperCase(), quantidade: 1 })
    });
    alert("Adicionado!");
    carregarLista();
}

function processarUrlManual() {
    const url = document.getElementById('url-input').value.trim();
    if (!url) return;
    const statusDiv = document.getElementById('status');
    statusDiv.classList.remove('hidden');
    statusDiv.innerText = "📡 Lendo nota...";
    fetch('/api/ProcessarNota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url })
    })
        .then(r => r.json())
        .then(data => {
            statusDiv.innerText = "✅ Nota lida!";
            renderPreview(data.dados);
        }).catch(() => statusDiv.innerText = "❌ Erro.");
}

async function renderPreview(dados) {
    const previewContainer = document.getElementById('preview-container');
    const listaItens = document.getElementById('lista-itens');
    listaItens.innerHTML = '';
    previewContainer.classList.remove('hidden');

    const respDict = await fetch('/api/VincularProdutos');
    const dicionario = await respDict.json();

    const header = document.createElement('div');
    header.className = "p-4 bg-blue-50 border-b border-blue-100 rounded-t-xl mb-2";
    header.innerHTML = `
                <div class="flex justify-between items-start mb-2">
                    <div><p class="text-[10px] font-black text-blue-400 uppercase tracking-widest">Estabelecimento</p><p class="text-xs font-bold text-gray-800 uppercase">${dados.estabelecimento || "DESCONHECIDO"}</p></div>
                    <div class="text-right"><p class="text-[10px] font-black text-blue-400 uppercase tracking-widest">Total</p><p class="text-sm font-black text-blue-600">R$ ${parseFloat(dados.valor_total || 0).toFixed(2)}</p></div>
                </div>
                <div class="flex justify-between items-center pt-2 border-t border-blue-100">
                    <p class="text-[10px] text-gray-500 font-medium">📦 ${dados.itens.length} itens encontrados</p>
                    <p class="text-[10px] text-gray-500 font-medium">📅 ${new Date(dados.data_compra).toLocaleDateString('pt-BR')}</p>
                </div>`;
    listaItens.appendChild(header);

    dados.itens.forEach(item => {
        const produtoVinculado = dicionario.find(p => p.ids_vinculados && p.ids_vinculados.includes(item.id_interno));
        const temNomeAmigavel = !!produtoVinculado;
        const temFoto = produtoVinculado && produtoVinculado.foto_url && !produtoVinculado.foto_url.includes('placeholder');

        const precoUnitario = item.preco_unitario || 0;
        const qtd = item.quantidade || 0;
        const precoTotalItem = item.preco_total || (precoUnitario * qtd);

        const itemDiv = document.createElement('div');
        itemDiv.className = "flex justify-between items-center p-3 border-b border-gray-100 last:border-0";
        itemDiv.innerHTML = `
                    <div class="flex-1 pr-2">
                        <p class="text-[11px] font-bold ${temNomeAmigavel ? 'text-gray-800' : 'text-red-500'} uppercase leading-tight">${temNomeAmigavel ? produtoVinculado.nome_comum : item.descricao}</p>
                        <div class="flex flex-wrap gap-2 mt-1 items-center">
                            <span class="text-[8px] px-1 rounded font-bold ${temNomeAmigavel ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'} uppercase">${temNomeAmigavel ? 'ID Vinculado' : 'ID Novo'}</span>
                            <span class="text-[8px] px-1 rounded font-bold ${temFoto ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'} uppercase">${temFoto ? 'Com Foto' : 'Sem Foto'}</span>
                            <p class="text-[10px] font-black text-blue-600">${qtd}x R$ ${precoUnitario.toFixed(2)} = <span class="text-blue-800">R$ ${precoTotalItem.toFixed(2)}</span></p>
                        </div>
                    </div>
                    <button onclick="vincularID('${item.id_interno}', '${escapeHTML(item.descricao)}')" class="ml-2 p-3 ${temNomeAmigavel && temFoto ? 'bg-gray-100 text-gray-400' : 'bg-blue-600 text-white'} rounded-full shadow-sm active:scale-90 transition-transform">${temNomeAmigavel && temFoto ? '✔️' : '🔗'}</button>`;
        listaItens.appendChild(itemDiv);
    });
}

function vincularID(id, desc) {
    const novoNome = prompt(`Nome padrão para "${desc}":`, desc);
    if (!novoNome) return;
    const cat = prompt(`Categoria:`, "OUTROS");
    const foto = prompt(`URL da Foto:`, "");
    fetch('/api/VincularProdutos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idPrincipal: id, nomePadrao: novoNome.toUpperCase(), categoria: cat.toUpperCase(), fotoUrl: foto })
    }).then(() => carregarLista());
}

async function abrirGrafico(nome) {
    let canvasHtml = `<div id="modal-grafico" class="fixed inset-0 bg-black/80 z-50 p-4 flex flex-col justify-center"><div class="bg-white rounded-2xl p-4 w-full max-w-lg shadow-2xl"><div class="flex justify-between items-center mb-4 border-b pb-2"><h3 class="text-[11px] font-black text-blue-600 uppercase tracking-wider">${nome}</h3><button onclick="document.getElementById('modal-grafico').remove()" class="text-red-500 font-bold px-3 py-1 hover:bg-red-50 rounded-lg transition-colors">X</button></div><div class="relative h-64"><canvas id="meuGrafico"></canvas></div><p class="text-[9px] text-gray-400 mt-4 text-center italic">Toque nos pontos para detalhes</p></div></div>`;
    document.body.insertAdjacentHTML('beforeend', canvasHtml);
    try {
        const response = await fetch(`/api/ObterHistoricoProduto?nome=${encodeURIComponent(nome)}`);
        const dados = await response.json();
        if (!dados.length) return;
        const ctx = document.getElementById('meuGrafico').getContext('2d');
        new Chart(ctx, {
            type: 'line',
            data: {
                labels: dados.map(d => {
                    const dt = new Date(d.data);
                    return dt.toLocaleDateString('pt-BR') + ' ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                }),
                datasets: [{
                    label: 'R$', data: dados.map(d => d.preco), borderColor: '#2563eb', backgroundColor: 'rgba(37, 99, 235, 0.1)', fill: true, tension: 0.3,
                    pointBackgroundColor: dados.map(d => d.mercado.includes('WMS') ? '#f59e0b' : '#ef4444'), pointBorderColor: '#fff', pointBorderWidth: 2, pointRadius: 6
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { tooltip: { callbacks: { afterLabel: (c) => 'Mercado: ' + dados[c.dataIndex].mercado } } }
            }
        });
    } catch (e) { }
}

async function carregarSugestoes() {
    try {
        const response = await fetch('/api/VincularProdutos');
        const produtos = await response.json();
        const datalist = document.getElementById('sugestoes-produtos');
        datalist.innerHTML = [...new Set(produtos.map(p => p.nome_comum))].map(nome => `<option value="${nome.toUpperCase()}">`).join('');
    } catch (e) { }
}

carregarLista();
carregarSugestoes();
