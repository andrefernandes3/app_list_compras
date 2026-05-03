// ================== ESTADO GLOBAL ==================
let itensSelecionados = new Set();
let meuGraficoRelatorio = null;
let timeoutPreco, timeoutQtd;

// ================== FUNÇÕES UTILITÁRIAS ==================
function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/'/g, "\\'");
}

function obterCorMercado(nomeMercado) {
    const cores = {
        'CARREFOUR': '#2ecc71',
        'PÃO': '#e67e22',
        'EXTRA': '#e74c3c',
        'ASSAI': '#e7e304',
        'ATACADAO': '#09ebfc',
        'SAMS CLUB': '#3906f1'
    };
    if (!nomeMercado) return '#3498db';
    const nomeUpper = nomeMercado.toUpperCase();
    const chave = Object.keys(cores).find(k => nomeUpper.includes(k));
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

// ================== ABAS ==================
function alternarAba(aba) {
    const abas = ['lista', 'dicionario', 'relatorios'];
    abas.forEach(a => {
        const div = document.getElementById(`secao-${a}`);
        const btnId = a === 'relatorios' ? 'btn-aba-rel' : (a === 'dicionario' ? 'btn-aba-dict' : 'btn-aba-lista');
        const btn = document.getElementById(btnId);
        if (a === aba) {
            div.classList.remove('hidden');
            btn.className = "flex-1 py-3 text-sm font-bold border-b-2 border-blue-600 text-blue-600";
        } else {
            div.classList.add('hidden');
            btn.className = "flex-1 py-3 text-sm font-bold text-gray-500";
        }
    });
    if (aba === 'lista') carregarLista();
    if (aba === 'dicionario') renderizarDicionario();
    if (aba === 'relatorios') carregarRelatorios();
}

// ================== RELATÓRIOS ==================
async function carregarRelatorios() {
    const ctx = document.getElementById('chartCategorias');
    const seletorLoja = document.getElementById('filtro-loja-relatorio');
    const lojaSelecionada = seletorLoja ? seletorLoja.value : "";
    try {
        const url = lojaSelecionada ? `/api/ObterRelatorioGastos?loja=${encodeURIComponent(lojaSelecionada)}` : '/api/ObterRelatorioGastos';
        const response = await fetch(url);
        const dados = await response.json();
        if (seletorLoja && seletorLoja.options.length <= 1) {
            const lojasResp = await fetch('/api/ListarLojas');
            const lojas = await lojasResp.json();
            lojas.forEach(loja => {
                const option = document.createElement('option');
                option.value = loja;
                option.innerText = `🏪 ${loja}`;
                seletorLoja.appendChild(option);
            });
        }
        if (meuGraficoRelatorio) meuGraficoRelatorio.destroy();
        if (!dados || dados.length === 0) return;
        meuGraficoRelatorio = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: dados.map(d => d._id),
                datasets: [{
                    data: dados.map(d => d.totalGasto),
                    backgroundColor: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#8AC926', '#1982C4', '#6A4C93'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '70%',
                onClick: (evt, activeElements) => {
                    if (activeElements.length) exibirDetalhesCategoria(dados[activeElements[0].index]);
                },
                plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 9, weight: 'bold' } } } }
            }
        });
    } catch (e) { console.error(e); }
}

function exibirDetalhesCategoria(categoria) {
    const container = document.getElementById('lista-gastos-detalhada');
    if (!container) return;
    const detalhesOrdenados = [...categoria.detalhes].sort((a, b) => a.nome.localeCompare(b.nome));
    let html = `<div class="mt-6 p-4 bg-blue-50 rounded-2xl"><h4 class="text-[10px] font-black text-blue-600 mb-3">📦 Detalhes: ${categoria._id}</h4><div class="space-y-2">`;
    detalhesOrdenados.forEach(item => {
        const unitario = item.valor / (item.qtd || 1);
        html += `<div class="flex justify-between text-[11px] bg-white p-2 rounded-lg"><span class="font-bold uppercase">${item.nome}</span><div><span class="text-gray-500 text-[9px]">${item.qtd}x R$ ${unitario.toFixed(2)}</span><span class="ml-2 font-black text-blue-700">R$ ${item.valor.toFixed(2)}</span></div></div>`;
    });
    html += `</div></div>`;
    container.innerHTML = html;
    container.scrollIntoView({ behavior: 'smooth' });
}

// ================== LISTA DE COMPRAS (OTIMIZADA PARA 100 ITENS) ==================
async function carregarLista() {
    const listaDiv = document.getElementById('lista-ativa');
    listaDiv.innerHTML = '<p class="text-gray-400 text-xs text-center animate-pulse">Sincronizando...</p>';
    try {
        const [itens, dicionario] = await Promise.all([
            fetch('/api/GerenciarLista').then(r => r.json()),
            fetch('/api/VincularProdutos').then(r => r.json())
        ]);
        if (itens.length === 0) {
            listaDiv.innerHTML = '<p class="text-gray-500 italic text-center py-4">Tudo pronto! 🎉</p>';
            document.getElementById('totalizador-estimado').classList.add('hidden');
            return;
        }
        // Ordena por categoria
        const itensOrdenados = itens.map(item => {
            const info = dicionario.find(p => p.nome_comum === item.item_nome) || {};
            return { ...item, categoria: info.categoria || "OUTROS" };
        }).sort((a, b) => a.categoria.localeCompare(b.categoria));
        listaDiv.innerHTML = '';
        let categoriaAtual = '';
        for (const item of itensOrdenados) {
            if (item.categoria !== categoriaAtual) {
                categoriaAtual = item.categoria;
                listaDiv.innerHTML += `<div class="text-[10px] font-black text-blue-500 mt-4 mb-2 uppercase tracking-widest border-l-4 border-blue-500 pl-2 bg-blue-50/50 py-1 rounded-r">📍 Corredor: ${categoriaAtual}</div>`;
            }
            const infoDict = dicionario.find(p => p.nome_comum === item.item_nome) || {};
            const idFormatado = item.item_nome.replace(/\s+/g, '-');
            const nomeSeguro = escapeHTML(item.item_nome);
            const isComprado = item.comprado === true;
            const qtd = item.quantidade || 1;
            const precoReal = item.preco_real || '';
            listaDiv.innerHTML += `
                <div class="bg-white p-2 rounded-xl border border-blue-50 shadow-sm mb-2 flex items-center gap-3 ${isComprado ? 'opacity-60' : ''}">
                    <div class="w-12 h-12 shrink-0 overflow-hidden rounded-lg border border-gray-100 bg-gray-50 cursor-pointer" 
                         onclick="ampliarImagem('${infoDict.foto_url || 'https://via.placeholder.com/50'}', '${nomeSeguro}')">
                        <img src="${infoDict.foto_url || 'https://via.placeholder.com/50'}" class="w-full h-full object-cover">
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="flex justify-between items-start">
                            <span class="nome-item font-bold text-gray-700 uppercase text-[10px] break-words cursor-pointer hover:text-blue-600" onclick="abrirGrafico('${nomeSeguro}')">
                                ${item.item_nome}
                            </span>
                            <div class="relative flex items-center gap-1 bg-blue-50/50 p-1 rounded-lg">
                                <div id="alerta-${idFormatado}" class="absolute -top-5 right-0 z-10 pointer-events-none"></div>
                                <input type="number" min="1" value="${qtd}" 
                                    class="input-qtd-real w-8 p-0 text-[10px] font-black text-blue-700 bg-transparent border-none text-center outline-none"
                                    oninput="calcularTotalReal(); agendarSalvarQtd('${nomeSeguro}', this.value)">
                                <span class="text-[8px] text-blue-400">x</span>
                                <input type="number" step="0.01" value="${precoReal}" placeholder="0,00"
                                    oninput="calcularTotalReal(); salvarPrecoNoBanco('${nomeSeguro}', this.value); verificarAlertaPreco('${nomeSeguro}', this.value, document.getElementById('alerta-${idFormatado}'))" 
                                    class="input-preco-real w-14 p-1 text-[10px] border border-blue-200 rounded text-center outline-none">
                                <button onclick="alternarStatus('${nomeSeguro}', ${!isComprado})" class="text-lg ml-1">${isComprado ? '🔄' : '✅'}</button>
                                <button onclick="deletarItem('${nomeSeguro}')" class="text-xs ml-1">🗑️</button>
                            </div>
                        </div>
                        <div id="preco-lista-${idFormatado}"></div>
                    </div>
                </div>`;
            if (precoReal) {
                verificarAlertaPreco(item.item_nome, precoReal, document.getElementById(`alerta-${idFormatado}`));
            }
        }
        // Atualiza ranking e pílulas (apenas uma vez, sem recarregar a lista)
        await atualizarInterfaceEconomia();
        calcularTotalReal();
    } catch (err) {
        console.error("Erro ao carregar lista:", err);
        listaDiv.innerHTML = '<p class="text-red-500 text-xs text-center">Erro ao carregar. Tente novamente.</p>';
    }
}

async function atualizarInterfaceEconomia() {
    const containerRanking = document.getElementById('mercados-soma');
    const totalDiv = document.getElementById('totalizador-estimado');
    if (!containerRanking || !totalDiv) return;

    try {
        // UMA única chamada para todos os 100 itens!
        const response = await fetch('/api/CompararPrecos');
        const data = await response.json();

        if (!data.ranking || data.ranking.length === 0) {
            totalDiv.classList.add('hidden');
            return;
        }

        totalDiv.classList.remove('hidden');
        containerRanking.innerHTML = '';

        // Renderiza os cards de ranking (Vila Yara vs Shopping)
        data.ranking.forEach((loja, index) => {
            const cor = obterCorMercado(loja.nome);
            const isVencedor = index === 0;
            containerRanking.innerHTML += `
                <div class="p-2 rounded-xl border ${isVencedor ? 'border-green-500 bg-green-50 shadow-md' : 'border-gray-100 bg-white'} text-center transition-all">
                    <p class="text-[7px] font-black uppercase tracking-tighter" style="color: ${cor}">${loja.nome}</p>
                    <p class="text-[11px] font-black text-gray-800">R$ ${loja.total.toFixed(2)}</p>
                    <p class="text-[6px] text-gray-400 font-bold">${loja.encontrados}/${loja.totalItens} ITENS</p>
                </div>`;
        });

        // Preenche as pílulas individuais nos 100 itens instantaneamente
        if (data.precosIndividuais) {
            Object.keys(data.precosIndividuais).forEach(nomeItem => {
                const idFormatado = nomeItem.replace(/\s+/g, '-');
                const elPila = document.getElementById(`preco-lista-${idFormatado}`);
                if (elPila) {
                    const info = data.precosIndividuais[nomeItem];
                    elPila.innerHTML = `
                        <div class="mt-1 text-[9px] bg-green-50 text-green-700 p-1 px-2 rounded-lg border border-green-200 flex justify-between items-center">
                            <span>💡 Sugestão: ${info.loja}</span>
                            <span class="font-black text-blue-600">R$ ${info.valor.toFixed(2)}</span>
                        </div>`;
                }
            });
        }
    } catch (e) { console.error("Erro na blindagem:", e); }
}

function calcularTotalReal() {
    let total = 0;
    document.querySelectorAll('#lista-ativa > div').forEach(card => {
        const preco = parseFloat(card.querySelector('.input-preco-real')?.value) || 0;
        const qtd = parseFloat(card.querySelector('.input-qtd-real')?.value) || 1;
        total += preco * qtd;
    });
    const display = document.getElementById('total-real-dinamico');
    if (display) display.innerText = `R$ ${total.toFixed(2).replace('.', ',')}`;
}

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
            // ⚠️ CORREÇÃO: Não recarrega a lista inteira, apenas atualiza ranking e total
            await atualizarInterfaceEconomia();
            calcularTotalReal();
        } catch (e) { console.error(e); }
    }, 1000);
}

// ================== GRÁFICO DO PRODUTO ==================
async function abrirGrafico(nome) {
    const modalHtml = `<div id="modal-grafico" class="fixed inset-0 bg-black/80 z-50 p-4 flex flex-col justify-center"><div class="bg-white rounded-2xl p-4 w-full max-w-lg shadow-2xl"><div class="flex justify-between items-center mb-4 border-b pb-2"><h3 class="text-[11px] font-black text-blue-600">${nome}</h3><button onclick="this.closest('#modal-grafico').remove()" class="text-red-500 font-bold px-3 py-1">X</button></div><div class="relative h-64"><canvas id="meuGrafico"></canvas></div></div></div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
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
                    backgroundColor: 'rgba(37,99,235,0.1)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 8,
                    pointBackgroundColor: dados.map(d => obterCorMercado(d.mercado)),
                    pointBorderColor: '#fff'
                }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });
    } catch (e) { console.error(e); }
}

// ================== DICIONÁRIO ==================
async function renderizarDicionario() {
    const container = document.getElementById('lista-dicionario');
    container.innerHTML = '<p class="text-center text-gray-400 p-4">Carregando...</p>';
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
            let catHtml = `<div class="mb-4"><h3 class="text-[10px] font-black text-blue-500 mb-2 uppercase border-l-4 border-blue-500 pl-2">${cat}</h3>`;
            itens.forEach(prod => {
                const nomeSeguro = escapeHTML(prod.nome_comum);
                catHtml += `
                    <div class="bg-white p-2 rounded-xl border border-gray-100 flex items-center mb-1 gap-3">
                        <input type="checkbox" data-nome="${nomeSeguro}" onchange="toggleSelecao('${nomeSeguro}', this.checked)" class="w-4 h-4">
                        <div class="w-10 h-10 shrink-0 rounded-lg bg-gray-50 cursor-pointer" onclick="ampliarImagem('${prod.foto_url || ''}', '${nomeSeguro}')">
                            <img src="${prod.foto_url || 'https://via.placeholder.com/50'}" class="w-full h-full object-cover">
                        </div>
                        <div class="flex-1"><p class="text-[10px] font-bold uppercase">${prod.nome_comum}</p></div>
                        <button onclick="adicionarDiretoALista('${nomeSeguro}')" class="bg-blue-50 text-blue-600 px-3 py-2 rounded-lg text-xs font-bold">🛒+</button>
                    </div>`;
            });
            catHtml += `</div>`;
            container.innerHTML += catHtml;
        }
    } catch (e) { console.error(e); }
}

function toggleSelecao(nome, checked) {
    if (checked) itensSelecionados.add(nome);
    else itensSelecionados.delete(nome);
    atualizarBotaoMultiplos();
}

function selecionarTudoDicionario(checked) {
    document.querySelectorAll('#lista-dicionario input[type="checkbox"]').forEach(cb => {
        cb.checked = checked;
        const nome = cb.getAttribute('data-nome');
        if (checked) itensSelecionados.add(nome);
        else itensSelecionados.delete(nome);
    });
    atualizarBotaoMultiplos();
}

function atualizarBotaoMultiplos() {
    const btn = document.getElementById('btn-adicionar-multiplos');
    const count = itensSelecionados.size;
    if (count > 0) {
        btn.classList.remove('hidden');
        btn.className = "fixed bottom-6 right-6 z-50 bg-green-600 text-white px-6 py-3 rounded-full text-xs font-black shadow-2xl animate-bounce border-2 border-white";
        btn.innerText = `🛒 ADICIONAR ${count} ITENS`;
    } else {
        btn.classList.add('hidden');
    }
}

async function enviarSelecionadosParaLista() {
    const btn = document.getElementById('btn-adicionar-multiplos');
    if (itensSelecionados.size === 0) return;
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
        itensSelecionados.clear();
        btn.disabled = false;
        btn.classList.add('hidden');
        alert(`${itensSelecionados.size} itens adicionados!`);
        alternarAba('lista');
    } catch (e) {
        console.error(e);
        btn.disabled = false;
        btn.innerText = `ADICIONAR ${itensSelecionados.size} ITENS`;
    }
}

// ================== MANIPULAÇÃO MANUAL ==================
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
    const nome = document.getElementById('novo-item-lista').value.trim().toUpperCase();
    if (!nome) return;
    const qtd = parseFloat(document.getElementById('qtd-item-lista').value) || 1;
    try {
        await fetch('/api/GerenciarLista', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, quantidade: qtd })
        });
        document.getElementById('novo-item-lista').value = '';
        document.getElementById('qtd-item-lista').value = '1';
        carregarLista();
    } catch (e) { console.error(e); }
}

async function adicionarDiretoALista(nome) {
    try {
        await fetch('/api/GerenciarLista', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: nome.toUpperCase(), quantidade: 1 })
        });
        alert("Item adicionado!");
        carregarLista();
    } catch (e) { console.error(e); }
}

async function deletarItem(nome) {
    if (!confirm(`Remover ${nome}?`)) return;
    try {
        await fetch(`/api/GerenciarLista?nome=${encodeURIComponent(nome)}`, { method: 'DELETE' });
        carregarLista();
    } catch (e) { console.error(e); }
}

async function finalizarCompra() {
    if (!confirm("Limpar toda a lista?")) return;
    try {
        await fetch('/api/GerenciarLista', { method: 'DELETE' });
        carregarLista();
    } catch (e) { console.error(e); }
}

// ================== NOTA FISCAL ==================
async function processarUrlManual() {
    const url = document.getElementById('url-input').value.trim();
    if (!url) return;
    const statusDiv = document.getElementById('status');
    statusDiv.classList.remove('hidden');
    statusDiv.innerText = "📡 Analisando...";
    try {
        let response = await fetch('/api/ProcessarNota', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, consulta: true })
        });
        let resData = await response.json();
        let apelidoFinal = resData.estabelecimento;
        const ehJuridico = /LTDA|S\.A|S\/A/i.test(apelidoFinal);
        if (!resData.jaConhecido || ehJuridico) {
            const novo = prompt(`Como chamar esta loja? (CNPJ: ${resData.cnpj})`, apelidoFinal);
            if (novo) apelidoFinal = novo.toUpperCase();
            else if (ehJuridico) {
                statusDiv.innerText = "⚠️ Cancelado – defina um apelido.";
                return;
            }
        }
        statusDiv.innerText = "💾 Salvando...";
        response = await fetch('/api/ProcessarNota', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, apelido: apelidoFinal })
        });
        resData = await response.json();
        statusDiv.innerText = `✅ Processado: ${resData.estabelecimento}`;
        document.getElementById('url-input').value = '';
        renderPreview(resData.dados);
        carregarLista();
    } catch (err) {
        statusDiv.innerText = "❌ Erro ao processar nota.";
        console.error(err);
    }
}

async function renderPreview(dados) {
    const preview = document.getElementById('preview-container');
    const listaItens = document.getElementById('lista-itens');
    listaItens.innerHTML = '';
    preview.classList.remove('hidden');
    const dicionario = await fetch('/api/VincularProdutos').then(r => r.json());
    let html = `<div class="p-4 bg-blue-50 rounded-t-xl"><div class="flex justify-between"><div><p class="text-[10px] font-black text-blue-400">Estabelecimento</p><p class="font-bold">${dados.estabelecimento || "DESCONHECIDO"}</p></div><div><p class="text-[10px] font-black text-blue-400">Total</p><p class="font-black text-blue-600">R$ ${parseFloat(dados.valor_total || 0).toFixed(2)}</p></div></div></div>`;
    dados.itens.forEach(item => {
        const vinculado = dicionario.find(p => p.ids_vinculados?.includes(item.id_interno));
        const temNome = !!vinculado;
        const temFoto = vinculado?.foto_url && !vinculado.foto_url.includes('placeholder');
        html += `
            <div class="flex justify-between items-center p-3 border-b">
                <div class="flex-1">
                    <p class="text-[11px] font-bold ${temNome ? 'text-gray-800' : 'text-orange-500'}">${temNome ? vinculado.nome_comum : item.descricao}</p>
                    <div class="flex gap-2 text-[8px] mt-1">
                        <span class="px-1 rounded ${temNome ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}">${temNome ? 'Vinculado' : 'Novo'}</span>
                        <span class="px-1 rounded ${temFoto ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}">${temFoto ? 'Com Foto' : 'Sem Foto'}</span>
                    </div>
                </div>
                <button onclick="vincularID('${item.id_interno}', '${escapeHTML(item.descricao)}')" class="p-3 rounded-full ${temNome && temFoto ? 'bg-gray-100 text-gray-400' : 'bg-orange-500 text-white'}">${temNome && temFoto ? '✔️' : '✏️'}</button>
            </div>`;
    });
    listaItens.innerHTML = html;
}

function vincularID(id, desc) {
    const nomeSugerido = desc.split('*')[0].trim().toUpperCase();
    const novoNome = prompt(`Nome padrão:`, nomeSugerido);
    if (!novoNome) return;
    const categoriaSugerida = sugerirCategoria(novoNome);
    const cat = prompt(`Categoria:`, categoriaSugerida);
    if (!cat) return;
    const foto = prompt(`URL da foto:`, "");
    fetch('/api/VincularProdutos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idPrincipal: id, nomePadrao: novoNome.toUpperCase(), categoria: cat.toUpperCase(), fotoUrl: foto })
    }).then(() => {
        processarUrlManual();
        renderizarDicionario();
    });
}

// ================== ALERTA E SUGESTÕES ==================
async function verificarAlertaPreco(nome, precoAtual, elementoDestino) {
    if (!precoAtual || precoAtual <= 0) {
        if (elementoDestino) elementoDestino.innerHTML = '';
        return;
    }
    try {
        const response = await fetch(`/api/ObterHistoricoProduto?nome=${encodeURIComponent(nome)}`);
        const historico = await response.json();
        if (!historico || historico.length === 0) return;
        const media = historico.reduce((acc, h) => acc + h.preco, 0) / historico.length;
        const diff = ((precoAtual - media) / media) * 100;
        let badge = "";
        if (diff < -5) badge = '<span class="bg-green-500 text-white text-[8px] px-1 rounded animate-bounce">🔥 BOM PREÇO</span>';
        else if (diff > 5) badge = `<span class="bg-red-500 text-white text-[8px] px-1 rounded">⚠️ CARO (Média: R$ ${media.toFixed(2)})</span>`;
        else badge = '<span class="bg-blue-400 text-white text-[8px] px-1 rounded">⚖️ NA MÉDIA</span>';
        if (elementoDestino) elementoDestino.innerHTML = badge;
    } catch (e) { console.error(e); }
}

function sugerirCategoria(nome) {
    const p = nome.toUpperCase();
    if (p.match(/QUEIJO|IOGURTE|MANTEIGA/)) return "FRIOS E CONGELADOS";
    if (p.match(/PÃO|BISCOITO|LEITE/)) return "PADARIA E MATINAIS";
    if (p.match(/DETERGENTE|SABAO/)) return "LIMPEZA";
    if (p.match(/CERVEJA|REFRIGERANTE/)) return "BEBIDAS";
    if (p.match(/CARNE|FRANGO/)) return "AÇOUGUE";
    if (p.match(/CAFÉ|ARROZ/)) return "MERCEARIA";
    if (p.match(/SHAMPOO|SABONETE/)) return "HIGIENE";
    if (p.match(/BANANA|MACA/)) return "HORTIFRUTI";
    return "OUTROS";
}

async function carregarSugestoes() {
    try {
        const produtos = await fetch('/api/VincularProdutos').then(r => r.json());
        const datalist = document.getElementById('sugestoes-produtos');
        if (datalist) {
            datalist.innerHTML = [...new Set(produtos.map(p => p.nome_comum))].map(n => `<option value="${n.toUpperCase()}">`).join('');
        }
    } catch (e) { console.error(e); }
}

// ================== INICIALIZAÇÃO ==================
carregarLista();
carregarSugestoes();