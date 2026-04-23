let totaisPorMercado = {};
let itensSelecionados = new Set();

// === FUNÇÕES UTILITÁRIAS ===
function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/'/g, "\\'");
}

function obterCorMercado(nomeMercado) {
    const cores = {
        'CARREFOUR': '#2ecc71',
        'WMS': '#f1c40f',
        'PÃO': '#e67e22',
        'EXTRA': '#e74c3c'
    };
    if (!nomeMercado) return '#3498db';
    const chave = Object.keys(cores).find(k => nomeMercado.toUpperCase().includes(k));
    return cores[chave] || '#3498db';
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
    
    document.getElementById('btn-aba-lista').className = isLista ? 
        "flex-1 py-3 text-sm font-bold border-b-2 border-blue-600 text-blue-600" : 
        "flex-1 py-3 text-sm font-bold text-gray-500";
    
    document.getElementById('btn-aba-dict').className = !isLista ? 
        "flex-1 py-3 text-sm font-bold border-b-2 border-blue-600 text-blue-600" : 
        "flex-1 py-3 text-sm font-bold text-gray-500";
    
    if (isLista) carregarLista(); else renderizarDicionario();
}

// === LÓGICA DA LISTA ATIVA ===
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
            const isComprado = item.comprado === true;
            const qtd = item.quantidade || 1;
            const precoReal = item.preco_real || '';

            const itemElement = document.createElement('div');
            itemElement.className = `bg-white p-2 rounded-xl border border-blue-50 shadow-sm mb-2 flex items-center gap-3 ${isComprado ? 'item-comprado opacity-60' : ''}`;

            itemElement.innerHTML = `
                <div class="w-12 h-12 shrink-0 overflow-hidden rounded-lg border border-gray-100 bg-gray-50 cursor-pointer" 
                     onclick="ampliarImagem('${infoDict.foto_url || 'https://via.placeholder.com/50'}', '${nomeSeguro}')">
                    <img src="${infoDict.foto_url || 'https://via.placeholder.com/50'}" class="w-full h-full object-cover">
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex justify-between items-start">
                        <span class="nome-item font-bold text-gray-700 uppercase text-[10px] break-words cursor-pointer hover:text-blue-600" onclick="abrirGrafico('${nomeSeguro}')">
                            ${item.item_nome}
                        </span>
                        <div class="flex items-center gap-1 bg-blue-50/50 p-1 rounded-lg">
                            <input type="number" min="1" value="${qtd}" 
                                class="input-qtd-real w-8 p-0 text-[10px] font-black text-blue-700 bg-transparent border-none text-center outline-none"
                                oninput="calcularTotalReal(); agendarSalvarQtd('${nomeSeguro}', this.value)">
                            <span class="text-[8px] text-blue-400">x</span>
                            <input type="number" step="0.01" value="${precoReal}" placeholder="0,00"
                                oninput="calcularTotalReal(); salvarPrecoNoBanco('${nomeSeguro}', this.value)" 
                                class="input-preco-real w-14 p-1 text-[10px] border border-blue-200 rounded text-center outline-none focus:ring-1 focus:ring-blue-500">
                            <button onclick="alternarStatus('${nomeSeguro}', ${!isComprado})" class="text-lg ml-1 active:scale-90 transition-transform">
                                ${isComprado ? '🔄' : '✅'}
                            </button>
                        </div>
                    </div>
                    <div id="preco-lista-${idFormatado}"></div>
                </div>`;
            listaDiv.appendChild(itemElement);
            buscarComparativo(item.item_nome, qtd, document.getElementById(`preco-lista-${idFormatado}`));
        });
        calcularTotalReal();
    } catch (err) { console.error(err); }
}

// === PERSISTÊNCIA E CÁLCULOS ===


function calcularTotalReal() {
    let total = 0;
    // Selecionamos todos os itens da lista, independente de estarem riscados ou não
    const cards = document.querySelectorAll('#lista-ativa > div');
    
    cards.forEach(card => {
        const inputPreco = card.querySelector('.input-preco-real');
        const inputQtd = card.querySelector('.input-qtd-real');
        
        // Verificamos se os inputs existem e se o item NÃO está marcado como comprado 
        // (ou se você deseja somar tudo, remova a verificação de classe)
        if (inputPreco && inputQtd) {
            const preco = parseFloat(inputPreco.value) || 0;
            const qtd = parseFloat(inputQtd.value) || 1;
            total += (preco * qtd);
        }
    });

    const display = document.getElementById('total-real-dinamico');
    if (display) {
        display.innerText = `R$ ${total.toFixed(2).replace('.', ',')}`;
    }
}
let timeoutPreco, timeoutQtd;

function salvarPrecoNoBanco(nome, valor) {
    clearTimeout(timeoutPreco);
    timeoutPreco = setTimeout(async () => {
        try {
            await fetch('/api/GerenciarLista', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nome: nome.toUpperCase(), preco_real: parseFloat(valor) || 0 })
            });
        } catch (e) { console.error(e); }
    }, 800);
}

function agendarSalvarQtd(nome, qtd) {
    clearTimeout(timeoutQtd);
    timeoutQtd = setTimeout(async () => {
        try {
            await fetch('/api/GerenciarLista', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nome: nome.toUpperCase(), quantidade: parseInt(qtd) || 1 })
            });
            // Recarrega a lista para atualizar os comparativos (subtotais por mercado)
            carregarLista();
        } catch (e) { console.error(e); }
    }, 1000);
}

// === GRÁFICO E COMPARATIVOS ===
async function abrirGrafico(nome) {
    let canvasHtml = `<div id="modal-grafico" class="fixed inset-0 bg-black/80 z-50 p-4 flex flex-col justify-center"><div class="bg-white rounded-2xl p-4 w-full max-w-lg shadow-2xl"><div class="flex justify-between items-center mb-4 border-b pb-2"><h3 class="text-[11px] font-black text-blue-600 uppercase tracking-wider">${nome}</h3><button onclick="document.getElementById('modal-grafico').remove()" class="text-red-500 font-bold px-3 py-1">X</button></div><div class="relative h-64"><canvas id="meuGrafico"></canvas></div><p class="text-[9px] text-gray-400 mt-4 text-center italic">Cores indicam o mercado onde o item foi comprado</p></div></div>`;
    document.body.insertAdjacentHTML('beforeend', canvasHtml);

    try {
        const response = await fetch(`/api/ObterHistoricoProduto?nome=${encodeURIComponent(nome)}`);
        const dados = await response.json();
        if (!dados.length) return;

        const ctx = document.getElementById('meuGrafico').getContext('2d');
        new Chart(ctx, {
            type: 'line',
            data: {
                labels: dados.map(d => new Date(d.data).toLocaleDateString('pt-BR')),
                datasets: [{
                    label: 'Preço R$',
                    data: dados.map(d => d.preco),
                    borderColor: '#2563eb',
                    backgroundColor: 'rgba(37, 99, 235, 0.1)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 8,
                    pointBackgroundColor: dados.map(d => obterCorMercado(d.mercado)),
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: (c) => `R$ ${c.parsed.y.toFixed(2)}`,
                            afterLabel: (c) => 'Mercado: ' + dados[c.dataIndex].mercado
                        }
                    }
                }
            }
        });
    } catch (e) { console.error(e); }
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
                <div data-mercado-badge="${mercado}" class="mt-1 text-[9px] bg-gray-50 text-gray-500 p-1 px-2 rounded-lg border border-gray-200 flex justify-between items-center transition-colors">
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
    const totalDiv = document.getElementById('totalizador-estimado');
    if (!container || !totalDiv) return;
    
    totalDiv.classList.remove('hidden');
    container.innerHTML = '';

    const entries = Object.entries(totaisPorMercado).sort((a, b) => a[1] - b[1]);
    const mercadoVencedor = entries.length > 0 ? entries[0][0] : null;

    entries.forEach(([m, v], i) => {
        const cor = i === 0 ? 'bg-green-100 border-green-200 text-green-700' : 'bg-gray-50 border-gray-200 text-gray-500';
        container.innerHTML += `<div class="p-2 rounded-lg border ${cor} text-center shadow-sm"><p class="text-[8px] uppercase">${m}</p><p class="text-xs font-bold">R$ ${v.toFixed(2)}</p></div>`;
    });

    document.querySelectorAll('[data-mercado-badge]').forEach(el => {
        const mercadoItem = el.getAttribute('data-mercado-badge');
        if (mercadoItem === mercadoVencedor) {
            el.className = "mt-1 text-[9px] bg-green-100 text-green-700 p-1 px-2 rounded-lg border border-green-200 flex justify-between items-center transition-colors";
        } else {
            el.className = "mt-1 text-[9px] bg-gray-50 text-gray-500 p-1 px-2 rounded-lg border border-gray-200 flex justify-between items-center transition-colors";
        }
    });
}

// === LÓGICA DO DICIONÁRIO ===
async function renderizarDicionario() {
    const container = document.getElementById('lista-dicionario');
    container.innerHTML = '<p class="text-center text-gray-400 p-4">Carregando catálogo...</p>';
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
                        <input type="checkbox" data-nome="${nomeSeguro}" onchange="toggleSelecao('${nomeSeguro}', this.checked)" class="w-4 h-4 rounded border-gray-300 text-blue-600">
                        <div class="w-10 h-10 shrink-0 overflow-hidden rounded-lg bg-gray-50 cursor-pointer" onclick="ampliarImagem('${fotoUrl}', '${nomeSeguro}')">
                            <img src="${fotoUrl}" class="w-full h-full object-cover">
                        </div>
                        <div class="flex-1"><p class="text-[10px] font-bold text-gray-800 uppercase">${prod.nome_comum}</p></div>
                        <button onclick="adicionarDiretoALista('${nomeSeguro}')" class="bg-blue-50 text-blue-600 px-3 py-2 rounded-lg text-xs font-bold active:scale-90">🛒+</button>
                    </div>`;
            });
            container.appendChild(div);
        }
    } catch (e) { console.error(e); }
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
    if (itensSelecionados.size === 0) return;

    const total = itensSelecionados.size;
    btn.innerText = "ADICIONANDO...";
    btn.disabled = true;

    try {
        for (let nome of itensSelecionados) {
            await fetch('/api/GerenciarLista', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nome: nome.toUpperCase(), quantidade: 1 })
            });
        }
        
        // LIMPEZA CRUCIAL APÓS O SUCESSO:
        itensSelecionados.clear(); 
        btn.disabled = false;
        btn.classList.add('hidden');
        
        alert(`${total} itens adicionados com sucesso!`);
        alternarAba('lista'); // Isso já chamará o carregarLista()
    } catch (e) {
        console.error(e);
        btn.disabled = false;
        btn.innerText = `ADICIONAR ${itensSelecionados.size} ITENS`;
    }
}

// === STATUS E MANIPULAÇÃO MANUAL ===
async function alternarStatus(nome, novoStatus) {
    try {
        await fetch('/api/GerenciarLista', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: nome.toUpperCase(), comprado: novoStatus })
        });
        carregarLista();
    } catch (e) { console.error(e); }
}

async function adicionarItemManual() {
    const inputNome = document.getElementById('novo-item-lista');
    const inputQtd = document.getElementById('qtd-item-lista');
    const nome = inputNome.value.trim().toUpperCase();
    if (!nome) return;
    try {
        await fetch('/api/GerenciarLista', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: nome, quantidade: parseFloat(inputQtd.value) || 1 })
        });
        inputNome.value = '';
        inputQtd.value = '1';
        carregarLista();
    } catch (e) { }
}

async function adicionarDiretoALista(nome) {
    try {
        await fetch('/api/GerenciarLista', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: nome.toUpperCase(), quantidade: 1 })
        });
        alert("Item adicionado à lista!");
        carregarLista(); // Atualiza a lista ativa se estiver visível
    } catch (e) { console.error(e); }
}

// === NOTA FISCAL ===
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
    }).then(() => {
        carregarLista();
        renderizarDicionario(); // atualiza o dicionário se estiver visível
    });
}

// === SUGESTÕES E INICIALIZAÇÃO ===
async function carregarSugestoes() {
    try {
        const response = await fetch('/api/VincularProdutos');
        const produtos = await response.json();
        const datalist = document.getElementById('sugestoes-produtos');
        if (datalist) {
            datalist.innerHTML = [...new Set(produtos.map(p => p.nome_comum))]
                .map(nome => `<option value="${nome.toUpperCase()}">`).join('');
        }
    } catch (e) { }
}

// Inicialização
carregarLista();
carregarSugestoes();