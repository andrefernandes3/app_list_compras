// ============================================================================
// 1. ESTADO GLOBAL E VARIÁVEIS
// ============================================================================
let totaisPorMercado = {};
let itensSelecionados = new Set();
let meuGraficoRelatorio = null;
let timeoutPreco, timeoutQtd;
let categoriaSelecionadaFiltro = "TUDO";

// Recupera precos digitados em tempo real na sessão
window.precosDigitadosNoMercado = JSON.parse(localStorage.getItem('precosLive')) || {};

// ============================================================================
// 2. FUNÇÕES UTILITÁRIAS
// ============================================================================
function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function obterCorMercado(nomeMercado) {
    const cores = {
        'CARREFOUR': '#2ecc71',
        'PÃO': '#e67e22',
        'EXTRA': '#e74c3c',
        'ASSAI': '#e7e304',
        'ATACADAO': '#09ebfc',
        'SAMS': '#3906f1'
    };
    if (!nomeMercado) return '#3498db';
    const nomeUpper = nomeMercado.toUpperCase();
    const chave = Object.keys(cores).find(k => nomeUpper.includes(k));
    return cores[chave] || '#3498db';
}

function ampliarImagem(url, nome) {
    if (!url || url.includes('placeholder')) return;
    const modalExistente = document.getElementById('modal-foto');
    if (modalExistente) modalExistente.remove();

    const modalHtml = `
        <div id="modal-foto" onclick="this.remove()" class="fixed inset-0 bg-black/90 z-[60] flex items-center justify-center p-4">
            <div class="relative w-full max-w-sm"> 
                <img src="${url}" class="w-full h-auto max-h-[70vh] object-contain rounded-2xl shadow-2xl border-4 border-white/10">
                <p class="text-white text-center mt-4 font-bold uppercase tracking-widest text-[10px]">${nome}</p>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

// ============================================================================
// 3. INTELIGÊNCIA DE CORES (ESCALA MIN-MAX COM CACHE)
// ============================================================================
window.cacheHistorico = {}; // Memória temporária para não travar a digitação

async function avaliarPrecoReal(precoAtual, nomeProduto) {
    if (!precoAtual || precoAtual <= 0) return { cor: 'border-gray-200 bg-white', status: '---' };

    let precos = window.cacheHistorico[nomeProduto];

    // Se a memória não tem o histórico desse produto ainda, busca no banco de dados silenciosamente
    if (!precos) {
        try {
            const res = await fetch(`/api/ObterHistoricoProduto?nome=${encodeURIComponent(nomeProduto)}`);
            const dados = await res.json();
            precos = dados.map(d => d.preco);
            window.cacheHistorico[nomeProduto] = precos; // Salva na memória
        } catch (e) {
            precos = [];
        }
    }

    if (!precos || precos.length === 0) return { cor: 'border-gray-200 bg-white', status: 'SEM HISTÓRICO' };

    const min = Math.min(...precos);
    const max = Math.max(...precos);

    // Se o preço nunca mudou na vida do produto
    if (min === max) {
        if (precoAtual < min) return { cor: 'border-green-400 bg-green-50', status: 'NOVO RECORDE!' };
        if (precoAtual > max) return { cor: 'border-red-400 bg-red-50', status: 'CARO' };
        return { cor: 'border-yellow-400 bg-yellow-50', status: 'PREÇO NA MÉDIA' };
    }

    // O CÁLCULO EXATO (Normalização Min-Max):
    const percentil = Math.round(((precoAtual - min) / (max - min)) * 100);

    // Classificação pelas faixas (Terços)
    if (percentil <= 33) {
        return { cor: 'border-green-400 bg-green-50', status: `BARATO (${percentil}%)` };
    } else if (percentil > 33 && percentil <= 66) {
        return { cor: 'border-yellow-400 bg-yellow-50', status: `JUSTO (${percentil}%)` };
    } else {
        return { cor: 'border-red-400 bg-red-50', status: `CARO (${percentil}%)` };
    }
}

window.atualizarCoresCard = async function (inputElement, nomeProduto) {
    const card = inputElement.closest('.card-produto-lista');
    if (!card) return;

    // Trata a vírgula do padrão brasileiro para fazer a matemática
    const precoAtual = parseFloat(inputElement.value.replace(',', '.')) || 0;

    // Faz a avaliação baseada no histórico REAL do produto
    const avaliacao = await avaliarPrecoReal(precoAtual, nomeProduto);

    // Aplica as cores no card principal
    card.className = `card-produto-lista p-2 rounded-xl border-2 transition-all flex flex-col gap-2 shadow-sm mb-3 ${avaliacao.cor} ${card.classList.contains('opacity-60') ? 'opacity-60' : ''}`;

    // Aplica as cores na barrinha inferior e adiciona a porcentagem
    const statusBar = card.querySelector('.status-percentil-bar');
    if (statusBar) {
        statusBar.className = `status-percentil-bar mt-2 text-[9px] p-1.5 px-2 rounded-lg border flex justify-between items-center shadow-sm ${avaliacao.cor}`;
        let statusBadge = statusBar.querySelector('.badge-status');
        if (!statusBadge) {
            statusBadge = document.createElement('span');
            statusBar.appendChild(statusBadge);
        }
        statusBadge.innerText = avaliacao.status;
        statusBadge.className = `badge-status font-black uppercase tracking-wider ml-2 ${avaliacao.cor.includes('green') ? 'text-green-700' : avaliacao.cor.includes('red') ? 'text-red-700' : 'text-yellow-700'}`;
    }
};

// ============================================================================
// 4. NAVEGAÇÃO ENTRE ABAS
// ============================================================================
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

// ============================================================================
// 5. RENDERIZAÇÃO DA LISTA DE COMPRAS
// ============================================================================
async function carregarLista() {
    totaisPorMercado = {};
    const listaDiv = document.getElementById('lista-ativa');
    listaDiv.innerHTML = '<p class="text-gray-400 text-xs text-center animate-pulse">Sincronizando...</p>';

    try {
        const [respLista, respDict, respPrecos] = await Promise.all([
            fetch('/api/GerenciarLista'),
            fetch('/api/VincularProdutos'),
            fetch('/api/CompararPrecos')
        ]);

        const itens = await respLista.json();
        const dicionario = await respDict.json();
        const dataPrecos = await respPrecos.json();

        window.totaisPorMercado = dataPrecos.precosPorLojaCompleto || {};
        window.dadosOriginaisDicionario = dataPrecos;

        if (itens.length === 0) {
            listaDiv.innerHTML = '<p class="text-gray-500 italic text-center py-4">Tudo pronto! 🎉</p>';
            document.getElementById('totalizador-estimado').classList.add('hidden');
            return;
        }

        const itensOrdenados = itens.map(item => {
            const info = dicionario.find(p => p.nome_comum === item.item_nome) || {};
            return { ...item, categoria: (info.categoria || "OUTROS").toUpperCase() };
        });

        itensOrdenados.sort((a, b) => a.categoria.localeCompare(b.categoria));
        renderizarFiltrosCategorias(itensOrdenados);

        listaDiv.innerHTML = '';
        let categoriaAtual = "";

        itensOrdenados.forEach(item => {
            const infoDict = dicionario.find(p => p.nome_comum === item.item_nome) || {};
            const idFormatado = item.item_nome.replace(/[^a-zA-Z0-9]/g, '_');
            const nomeSeguro = escapeHTML(item.item_nome);
            const isComprado = item.comprado === true;
            const precoManual = item.preco_real || '';

            if (item.categoria !== categoriaAtual) {
                categoriaAtual = item.categoria;
                listaDiv.innerHTML += `<div class="header-corredor text-[10px] font-black text-blue-500 mt-4 mb-2 uppercase tracking-widest border-l-4 border-blue-50 border-blue-500 pl-2 bg-blue-50/50 py-1 rounded-r" data-categoria="${categoriaAtual}">📍 CORREDOR: ${categoriaAtual}</div>`;
            }

            const itemElement = document.createElement('div');
            // O card nasce neutro (cinza) e será colorido instantaneamente pela função de pilulas
            itemElement.className = `card-produto-lista p-2 bg-white rounded-xl border-2 border-gray-200 shadow-sm mb-3 flex flex-col gap-2 ${isComprado ? 'opacity-60' : ''}`;
            itemElement.setAttribute('data-produto', item.item_nome.trim().toUpperCase());
            itemElement.setAttribute('data-categoria-produto', item.categoria);

            itemElement.innerHTML = `
                <div class="flex items-center justify-between w-full">
                    <div class="flex items-center gap-2 flex-1 min-w-0">
                        <div class="w-10 h-10 shrink-0 overflow-hidden rounded-lg border border-gray-100 bg-gray-50 cursor-pointer" onclick="ampliarImagem('${infoDict.foto_url || 'https://via.placeholder.com/50'}', '${nomeSeguro}')">
                            <img src="${infoDict.foto_url || 'https://via.placeholder.com/50'}" class="w-full h-full object-cover">
                        </div>
                        <span class="nome-item font-bold text-gray-700 uppercase text-[11px] leading-tight truncate" onclick="abrirGrafico('${nomeSeguro}')">${item.item_nome}</span>
                    </div>
                    <div class="flex items-center gap-1 shrink-0 ml-2">
                        <input type="number" min="1" value="${item.quantidade || 1}" 
                            class="input-qtd-real w-8 p-1 text-[11px] font-black text-blue-700 bg-blue-50 border border-blue-100 rounded text-center outline-none"
                            oninput="calcularTotalReal(); agendarSalvarQtd('${nomeSeguro}', this.value)">
                        <span class="text-[9px] text-gray-400 font-bold px-1">x</span>
                        <input type="number" step="0.01" value="${precoManual}" placeholder="0,00"
                            oninput="calcularTotalReal(); salvarPrecoNoBanco('${nomeSeguro}', this.value); atualizarCoresCard(this, '${nomeSeguro}')" 
                            class="input-preco-real w-16 p-1 text-[11px] font-black border border-gray-300 rounded text-center outline-none bg-white focus:ring-2 focus:ring-blue-500">
                        <button onclick="alternarStatus('${nomeSeguro}', ${!isComprado})" class="text-sm ml-1 w-6 h-6 flex items-center justify-center rounded border ${isComprado ? 'bg-green-100 border-green-300' : 'bg-gray-100 border-gray-300'} active:scale-90 transition-transform">${isComprado ? '✅' : '☑️'}</button>
                        <button onclick="deletarItem('${nomeSeguro}')" class="text-sm ml-1 text-gray-400 hover:text-red-500">🗑️</button>
                    </div>
                </div>
                <div id="preco-lista-${idFormatado}" class="w-full"></div>`;
            listaDiv.appendChild(itemElement);
        });

        setTimeout(() => {
            atualizarPrecosEPilulas();
            calcularTotalReal();
            if (typeof categoriaSelecionadaFiltro !== 'undefined' && categoriaSelecionadaFiltro !== "TUDO") {
                filtrarPorCorredor(categoriaSelecionadaFiltro);
            }
        }, 300);

    } catch (err) {
        console.error("Erro fatal ao processar a lista:", err);
    }
}

async function atualizarPrecosEPilulas() {
    try {
        const data = window.dadosOriginaisDicionario || await fetch('/api/CompararPrecos').then(r => r.json());
        const cards = document.querySelectorAll('#lista-ativa .card-produto-lista');

        cards.forEach(card => {
            const nomeProduto = card.getAttribute('data-produto');
            const nomeReal = Object.keys(data.precosPorLojaCompleto || {}).find(k => k.trim().toUpperCase() === nomeProduto) || nomeProduto;
            const containerPreco = document.getElementById(`preco-lista-${nomeReal.replace(/[^a-zA-Z0-9]/g, '_')}`);
            if (!containerPreco) return;

            const precos = data.precosPorLojaCompleto?.[nomeReal] || {};
            const dig = window.precosDigitadosNoMercado?.[nomeReal] || {};
            const menorH = data.precosIndividuais?.[nomeReal]?.valor || 0;

            containerPreco.innerHTML = `
                <div class="grid grid-cols-4 gap-1 w-full mt-1">
                    ${renderInputMercado('Carrefour', dig['CARREFOUR'], precos[Object.keys(precos).find(k => k.includes("CARREFOUR"))], 'bg-gray-100 text-gray-700 border-gray-200', nomeReal, 'CARREFOUR')}
                    ${renderInputMercado('Assaí', dig['ASSAI'], precos[Object.keys(precos).find(k => k.includes("ASSAI"))], 'bg-orange-50 text-orange-700 border-orange-200', nomeReal, 'ASSAI')}
                    ${renderInputMercado('Atacadão', dig['ATACADAO'], precos[Object.keys(precos).find(k => k.includes("ATACADAO"))], 'bg-cyan-50 text-cyan-700 border-cyan-200', nomeReal, 'ATACADAO')}
                    ${renderInputMercado('Sams', dig['SAMS CLUB'], precos[Object.keys(precos).find(k => k.includes("SAMS"))], 'bg-indigo-50 text-indigo-700 border-indigo-200', nomeReal, 'SAMS CLUB')}
                </div>
                <div class="status-percentil-bar mt-2 text-[9px] p-1.5 px-2 rounded-lg border flex justify-between items-center shadow-sm bg-white">
                    <span class="text-gray-500 font-medium">💡 Menor Histórico: ${data.precosIndividuais?.[nomeReal]?.loja || 'N/A'}</span>
                    <span class="font-black text-gray-700">R$ ${menorH > 0 ? menorH.toFixed(2) : '--'}</span>
                </div>`;

            // Ativa a cor baseada no menor histórico
            const inputPrecoManual = card.querySelector('.input-preco-real');
            if (inputPrecoManual.value) {
                atualizarCoresCard(inputPrecoManual, nomeProduto);
            }
        });
        recalcularRankingLive(data.ranking || []);
    } catch (e) { console.error("Erro nas pílulas:", e); }
}

function renderInputMercado(label, valorDigitado, valorBanco, classes, nomeProduto, rede) {
    // Verifica se há um valor digitado em memória para essa sessão
    const temDigitado = valorDigitado !== undefined && valorDigitado !== null && valorDigitado !== '';
    const valorExibido = temDigitado ? valorDigitado : (valorBanco || '');
    
    // Define o indicador visual que ficará no cantinho da caixa
    let indicador = '';
    if (temDigitado && valorExibido !== '') {
        indicador = '<span class="absolute top-0.5 right-0.5 text-[8px]" title="Você digitou agora">✍️</span>';
    } else if (valorExibido !== '') {
        indicador = '<span class="absolute top-0.5 right-0.5 text-[8px] opacity-50" title="Preço puxado do Robô/Banco">🤖</span>';
    }

    return `
        <div class="flex-1 p-1 rounded-lg border ${classes} text-center shadow-sm relative">
            ${indicador}
            <div class="text-[7px] uppercase font-black tracking-wider opacity-75 mb-0.5 pr-2">${label}</div>
            <input type="number" step="0.01" value="${valorExibido}" placeholder="---"
                class="w-full bg-transparent border-none text-center outline-none text-[10px] p-0 font-black text-gray-900"
                oninput="registrarPrecoLive('${nomeProduto.replace(/'/g, "\\'")}', '${rede}', this.value)">
        </div>`;
}

// ============================================================================
// 6. CÁLCULOS E PERSISTÊNCIA NA LISTA
// ============================================================================
function calcularTotalReal() {
    let total = 0;
    document.querySelectorAll('#lista-ativa .card-produto-lista').forEach(card => {
        const inputPreco = card.querySelector('.input-preco-real');
        const inputQtd = card.querySelector('.input-qtd-real');
        if (inputPreco && inputQtd) {
            // Tratamento de vírgula para número JS
            const preco = parseFloat(inputPreco.value.replace(',', '.')) || 0;
            const qtd = parseFloat(inputQtd.value) || 1;
            total += preco * qtd;
        }
    });
    const display = document.getElementById('total-real-dinamico');
    if (display) display.innerText = `R$ ${total.toFixed(2).replace('.', ',')}`;
}

function salvarPrecoNoBanco(nome, valor) {
    clearTimeout(timeoutPreco);
    timeoutPreco = setTimeout(async () => {
        try {
            const valorCorrigido = parseFloat(valor.toString().replace(',', '.')) || 0;
            await fetch('/api/GerenciarLista', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nome: nome.toUpperCase(), preco_real: valorCorrigido })
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
            atualizarPrecosEPilulas();
            calcularTotalReal();
        } catch (e) { console.error(e); }
    }, 1000);
}

async function registrarPrecoLive(nome, rede, valor) {
    const numValor = parseFloat(valor.replace(',', '.'));
    if (!window.precosDigitadosNoMercado[nome]) window.precosDigitadosNoMercado[nome] = {};
    window.precosDigitadosNoMercado[nome][rede] = isNaN(numValor) ? null : numValor;
    recalcularRankingLive();

    if (!isNaN(numValor) && numValor > 0) {
        try {
            await fetch('/api/GerenciarPrecosTemp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item: nome.toUpperCase(), loja: rede.toUpperCase(), preco: numValor })
            });
        } catch (e) { console.error("Erro ao sincronizar preço temporário:", e); }
    }
}

function recalcularRankingLive() {
    const containerRanking = document.getElementById('totalizador-estimado');
    if (!containerRanking) return;

    const lojas = ['CARREFOUR', 'ASSAI', 'ATACADAO', 'SAMS CLUB'];
    const totais = { 'CARREFOUR': 0, 'ASSAI': 0, 'ATACADAO': 0, 'SAMS CLUB': 0 };

    document.querySelectorAll('#lista-ativa .card-produto-lista').forEach(card => {
        const nome = card.getAttribute('data-produto');
        const qtd = parseFloat(card.querySelector('.input-qtd-real')?.value) || 1;
        
        lojas.forEach(loja => {
            let p = window.precosDigitadosNoMercado[nome]?.[loja];
            if (p === undefined || p === null) {
                const dadosBanco = window.dadosOriginaisDicionario?.precosPorLojaCompleto?.[nome];
                const chaveBanco = Object.keys(dadosBanco || {}).find(k => k.toUpperCase().includes(loja));
                p = chaveBanco ? dadosBanco[chaveBanco] : 0;
            }
            if (p > 0) totais[loja] += p * qtd;
        });
    });

    const ranking = Object.entries(totais).filter(([_, t]) => t > 0).map(([nome, total]) => ({ nome, total })).sort((a, b) => a.total - b.total);
    
    if (ranking.length === 0) {
        containerRanking.classList.add('hidden');
        return;
    }

    containerRanking.classList.remove('hidden');
    let html = `<p class="text-[9px] font-black text-blue-100 uppercase tracking-widest mb-2 text-center">📊 Melhor Mercado Atual</p><div class="flex gap-2 overflow-x-auto pb-1 no-scrollbar">`;
    ranking.forEach((l, idx) => {
        const isWin = idx === 0;
        html += `<div class="min-w-[110px] p-2 rounded-xl border-l-4 ${isWin ? 'border-green-400 bg-white' : 'border-blue-400 bg-blue-500/50'} shadow-md">
            <p class="text-[7px] font-black ${isWin ? 'text-gray-500' : 'text-blue-100'} uppercase">${l.nome}</p>
            <p class="text-sm font-black ${isWin ? 'text-gray-800' : 'text-white'}">R$ ${l.total.toFixed(2)}</p>
        </div>`;
    });
    containerRanking.innerHTML = html + `</div>`;
}

// ============================================================================
// 7. GERENCIAMENTO DA LISTA (Adicionar, Deletar, Finalizar)
// ============================================================================
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
        carregarLista();
    } catch (e) { console.error(e); }
}

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

async function deletarItem(nome) {
    if (!confirm(`Remover ${nome} da lista?`)) return;
    try {
        await fetch(`/api/GerenciarLista?nome=${encodeURIComponent(nome)}`, { method: 'DELETE' });
        if (window.precosDigitadosNoMercado && window.precosDigitadosNoMercado[nome]) {
            delete window.precosDigitadosNoMercado[nome];
            localStorage.setItem('precosLive', JSON.stringify(window.precosDigitadosNoMercado));
        }
        carregarLista();
    } catch (e) { console.error(e); }
}

async function finalizarCompra() {
    if (!confirm("Deseja finalizar e limpar toda a lista?")) return;
    try {
        await Promise.all([
            fetch('/api/GerenciarLista', { method: 'DELETE' }),
            fetch('/api/GerenciarPrecosTemp', { method: 'DELETE' })
        ]);
        window.precosDigitadosNoMercado = {};
        localStorage.removeItem('precosLive');
        carregarLista();
        document.getElementById('total-real-dinamico').innerText = "R$ 0,00";
    } catch (e) { console.error("Erro ao finalizar:", e); }
}

// ============================================================================
// 8. RELATÓRIOS E GRÁFICOS
// ============================================================================
async function carregarRelatorios() {
    const ctx = document.getElementById('chartCategorias');
    const seletorLoja = document.getElementById('filtro-loja-relatorio');
    const lojaSelecionada = seletorLoja ? seletorLoja.value : "";
    try {
        const url = (lojaSelecionada && lojaSelecionada !== "") ? `/api/ObterRelatorioGastos?loja=${encodeURIComponent(lojaSelecionada)}` : '/api/ObterRelatorioGastos';
        const response = await fetch(url);
        const dados = await response.json();

        if (seletorLoja && seletorLoja.options.length <= 1) await carregarFiltroLojas();
        if (meuGraficoRelatorio) meuGraficoRelatorio.destroy();
        if (!dados || dados.length === 0) return;

        meuGraficoRelatorio = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: dados.map(d => d._id),
                datasets: [{ data: dados.map(d => d.totalGasto), backgroundColor: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#8AC926', '#1982C4', '#6A4C93'], borderWidth: 0 }]
            },
            options: { responsive: true, maintainAspectRatio: false, cutout: '70%', onClick: (evt, activeElements) => { if (activeElements.length > 0) exibirDetalhesCategoria(dados[activeElements[0].index]); }, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 9, weight: 'bold' } } } } }
        });
    } catch (e) { console.error(e); }
}

async function carregarFiltroLojas() {
    const seletor = document.getElementById('filtro-loja-relatorio');
    const lojas = await fetch('/api/ListarLojas').then(r => r.json());
    lojas.forEach(loja => { const option = document.createElement('option'); option.value = loja; option.innerText = `🏪 ${loja}`; seletor.appendChild(option); });
}

function exibirDetalhesCategoria(categoria) {
    const container = document.getElementById('lista-gastos-detalhada');
    if (!container) return;
    const detalhesOrdenados = [...categoria.detalhes].sort((a, b) => a.nome.localeCompare(b.nome));
    let html = `<div class="mt-6 p-4 bg-blue-50 rounded-2xl border border-blue-100"><h4 class="text-[10px] font-black text-blue-600 uppercase mb-3 tracking-widest text-center">📦 Detalhes: ${categoria._id}</h4><div class="space-y-2">`;
    detalhesOrdenados.forEach(item => { html += `<div class="flex justify-between items-center text-[11px] bg-white p-2 rounded-lg shadow-sm"><div class="flex flex-col"><span class="text-gray-600 font-bold uppercase truncate pr-2">${item.nome}</span><span class="text-[9px] text-gray-400 font-medium">${item.qtd}x de R$ ${(item.valor / (item.qtd || 1)).toFixed(2)}</span></div><span class="text-blue-700 font-black whitespace-nowrap">R$ ${item.valor.toFixed(2)}</span></div>`; });
    container.innerHTML = html + `</div></div>`;
    container.scrollIntoView({ behavior: 'smooth' });
}

async function renderizarRankingTopCompras() {
    const container = document.getElementById('lista-gastos-detalhada');
    if (!container) return;
    container.innerHTML = '<p class="text-center text-gray-400 text-[10px] animate-pulse py-8">CALCULANDO...</p>';
    try {
        const dados = await fetch('/api/ObterRankingTopCompras').then(r => r.json());
        let html = `<div class="mt-8"><h3 class="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-4 text-center">🏆 TOP 10 PRODUTOS</h3><div class="space-y-2">`;
        dados.forEach((item, index) => {
            html += `<div onclick="abrirGrafico('${item._id}')" class="bg-white p-3 rounded-2xl border border-gray-100 shadow-sm flex items-center gap-4 cursor-pointer hover:bg-blue-50">
                        <span class="text-lg font-black text-blue-200">#${index + 1}</span>
                        <div class="flex-1"><p class="text-[10px] font-black text-gray-700 uppercase">${item._id}</p><p class="text-[9px] text-gray-400 font-bold">${item.vezesComprado} notas fiscais</p></div>
                        <div class="text-right"><p class="text-sm font-black text-blue-600">${item.totalQtd} un</p><p class="text-[8px] text-gray-400">R$ ${item.totalGasto.toFixed(2)}</p></div>
                    </div>`;
        });
        container.innerHTML = html + `</div></div>`;
    } catch (e) { console.error(e); }
}

async function renderizarGraficoMedias() {
    const container = document.getElementById('lista-gastos-detalhada');
    container.innerHTML = '<div class="h-64 w-full"><canvas id="chartMediasTop10"></canvas></div>';
    try {
        const dados = await fetch('/api/ObterMediaPrecoTop10').then(r => r.json());
        new Chart(document.getElementById('chartMediasTop10'), {
            type: 'bar',
            data: { labels: dados.map(d => d._id.split(' ')[0] + '...'), datasets: [{ label: 'Preço Médio (R$)', data: dados.map(d => d.precoMedio), backgroundColor: 'rgba(54, 162, 235, 0.6)', borderRadius: 8 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });
    } catch (e) { console.error(e); }
}

async function abrirGrafico(nome) {
    const modalExistente = document.getElementById('modal-grafico');
    if (modalExistente) modalExistente.remove();

    const nomeSeguro = nome.replace(/'/g, "\\'");
    document.body.insertAdjacentHTML('beforeend', `
        <div id="modal-grafico" class="fixed inset-0 bg-black/80 z-[60] p-4 flex flex-col justify-center">
            <div class="bg-white rounded-3xl p-6 w-full max-w-lg shadow-2xl animate-fade-in">
                <div class="flex justify-between items-start mb-4">
                    <div><p class="text-[10px] font-black text-blue-400 uppercase tracking-[0.2em]">Histórico de Preços</p><h3 class="text-sm font-black text-gray-800 uppercase leading-tight">${nome}</h3></div>
                    <button onclick="document.getElementById('modal-grafico').remove()" class="bg-red-50 text-red-500 rounded-full w-8 h-8 flex items-center justify-center font-bold">✕</button>
                </div>
                <div class="flex gap-2 mb-6 justify-center" id="filtros-grafico">
                    <button onclick="filtrarPeriodoGrafico('${nomeSeguro}', 7, this)" class="btn-filtro flex-1 py-2 bg-gray-100 text-[9px] font-black rounded-xl">7D</button>
                    <button onclick="filtrarPeriodoGrafico('${nomeSeguro}', 30, this)" class="btn-filtro flex-1 py-2 bg-gray-100 text-[9px] font-black rounded-xl">30D</button>
                    <button onclick="filtrarPeriodoGrafico('${nomeSeguro}', 90, this)" class="btn-filtro flex-1 py-2 bg-gray-100 text-[9px] font-black rounded-xl">90D</button>
                    <button onclick="filtrarPeriodoGrafico('${nomeSeguro}', 0, this)" class="btn-filtro flex-1 py-2 bg-blue-600 text-white text-[9px] font-black rounded-xl shadow-md">TUDO</button>
                </div>
                <div class="relative h-64"><canvas id="meuGrafico"></canvas></div>          
            </div>
        </div>`);
    await filtrarPeriodoGrafico(nome, 0);
}

async function filtrarPeriodoGrafico(nome, dias, btn = null) {
    if (btn) {
        document.querySelectorAll('.btn-filtro').forEach(b => {
            b.classList.remove('bg-blue-600', 'text-white', 'shadow-md');
            b.classList.add('bg-gray-100', 'text-gray-500');
        });
        btn.classList.remove('bg-gray-100', 'text-gray-500');
        btn.classList.add('bg-blue-600', 'text-white', 'shadow-md');
    }

    try {
        const url = dias > 0
            ? `/api/ObterHistoricoProduto?nome=${encodeURIComponent(nome)}&dias=${dias}`
            : `/api/ObterHistoricoProduto?nome=${encodeURIComponent(nome)}`;
        const dados = await fetch(url).then(r => r.json());

        const ctx = document.getElementById('meuGrafico');
        let chartInstance = Chart.getChart(ctx);

        // Configuração atualizada com legenda personalizada
        const config = {
            type: 'line',
            data: {
                labels: dados.map(d => new Date(d.data).toLocaleDateString('pt-BR')),
                datasets: [{
                    label: 'Preço R$',
                    data: dados.map(d => d.preco),
                    borderColor: '#2563eb',
                    backgroundColor: 'rgba(37, 99, 235, 0.05)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 6,
                    pointBackgroundColor: dados.map(d => obterCorMercado(d.mercado)),
                    pointBorderWidth: 2,
                    pointBorderColor: '#fff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,               // legenda visível
                        position: 'bottom',
                        labels: {
                            usePointStyle: true,
                            font: { size: 10, weight: 'bold' },
                            generateLabels: (chart) => {
                                // Lista de mercados únicos presentes nos dados
                                const mercados = [...new Set(dados.map(d => d.mercado))];
                                return mercados.map(m => ({
                                    text: m,
                                    fillStyle: obterCorMercado(m),
                                    pointStyle: 'circle'
                                }));
                            }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: (c) => `R$ ${c.parsed.y.toFixed(2)}`,
                            afterLabel: (c) => `Loja: ${dados[c.dataIndex].mercado}`
                        }
                    }
                },
                scales: {
                    y: { beginAtZero: false }
                }
            }
        };

        if (chartInstance) {
            chartInstance.data = config.data;
            chartInstance.update();
        } else {
            new Chart(ctx, config);
        }
    } catch (e) {
        console.error(e);
    }
}

// ============================================================================
// 9. DICIONÁRIO, EAN E ROBÔ
// ============================================================================
async function renderizarDicionario() {
    const container = document.getElementById('lista-dicionario');
    if (!container) return;
    container.innerHTML = '<p class="text-center text-gray-400 p-4">Carregando catálogo...</p>';
    itensSelecionados.clear();

    const btnMultiplos = document.getElementById('btn-adicionar-multiplos');
    if (btnMultiplos) btnMultiplos.classList.add('hidden');

    try {
        const produtos = await fetch('/api/VincularProdutos').then(r => r.json());
        const categories = {};
        produtos.forEach(p => { const cat = (p.categoria || "OUTROS").toUpperCase(); if (!categories[cat]) categories[cat] = []; categories[cat].push(p); });

        container.innerHTML = `<div class="flex justify-between items-center mb-4 px-2 mt-2"><h2 class="text-[11px] font-black text-gray-400 uppercase tracking-widest">Catálogo do Robô</h2><button onclick="limparTodaMonitoracao()" class="bg-red-50 text-red-600 px-3 py-1.5 rounded-lg text-[10px] font-black border border-red-100">🔕 DESLIGAR ROBÔ</button></div>`;

        for (const [cat, itens] of Object.entries(categories)) {
            const div = document.createElement('div');
            div.className = "mb-4 block-categoria-dicionario";
            div.setAttribute('data-categoria-dict', cat);
            div.innerHTML = `<h3 class="text-[10px] font-black text-blue-500 mb-2 uppercase tracking-widest border-l-4 border-blue-500 pl-2">${cat}</h3>`;

            itens.forEach(prod => {
                const fotoUrl = prod.foto_url || 'https://via.placeholder.com/50';
                const nomeSeguro = escapeHTML(prod.nome_comum);
                const eanFaltando = !prod.ean ? 'border-orange-300 bg-orange-50' : 'border-gray-100 bg-white';

                div.innerHTML += `
                    <div class="item-dicionario-lista p-2 rounded-xl border flex flex-col md:flex-row md:items-center mb-2 shadow-sm gap-2 ${eanFaltando}" data-categoria-dict="${cat}">
                        <div class="flex items-center gap-2 flex-1 w-full">
                            <input type="checkbox" data-nome="${nomeSeguro}" onchange="toggleSelecao('${nomeSeguro}', this.checked)" class="w-4 h-4 rounded text-blue-600">
                            <div class="w-10 h-10 shrink-0 overflow-hidden rounded-lg bg-gray-50 cursor-pointer" onclick="ampliarImagem('${fotoUrl}', '${nomeSeguro}')"><img src="${fotoUrl}" class="w-full h-full object-cover"></div>
                            <div class="flex-1 flex flex-col min-w-0">
                                <p class="text-[10px] font-bold text-gray-800 uppercase truncate">${prod.nome_comum}</p>
                                <button onclick="abrirGrafico('${nomeSeguro.replace(/'/g, "\\'")}')" class="text-[11px] opacity-60 text-left">📊 Gráfico</button>
                            </div>
                        </div>
                        <div class="flex items-center justify-between gap-2 w-full md:w-auto mt-2 md:mt-0 pt-2 md:pt-0 border-t md:border-none border-black/5">
                            <div class="flex flex-col gap-1.5 flex-1">
                                <div class="flex gap-1">
                                    <input type="text" class="input-ean w-full md:w-20 p-1 text-[9px] font-mono text-center border rounded" placeholder="EAN" value="${prod.ean || ''}" onchange="salvarAlteracoesItem('${prod._id}', this)">
                                    <button onclick="iniciarScannerEAN(this)" class="bg-gray-200 px-2 rounded text-[10px]">📷</button>
                                </div>
                                <input type="number" step="0.01" class="input-alvo w-full md:w-28 p-1 text-[9px] font-black text-blue-700 text-center border rounded" placeholder="R$ Alvo" value="${prod.preco_alvo || ''}" onchange="salvarAlteracoesItem('${prod._id}', this)">
                            </div>
                            <div class="flex flex-col items-center gap-1 bg-blue-50/50 p-2 rounded-lg border">
                                <span class="text-[7px] uppercase font-black text-blue-400">Robô</span>
                                <input type="checkbox" class="toggle-monitorar w-4 h-4" ${prod.monitorar ? 'checked' : ''} onchange="salvarAlteracoesItem('${prod._id}', this)">
                            </div>
                            <button onclick="adicionarDiretoALista('${nomeSeguro}')" class="bg-blue-50 text-blue-600 px-3 py-3 rounded-lg text-xs font-bold">🛒+</button>
                        </div>
                    </div>`;
            });
            container.appendChild(div);
        }
        if (typeof categoriaSelecionadaFiltro !== 'undefined' && categoriaSelecionadaFiltro !== "TUDO") filtrarPorCorredor(categoriaSelecionadaFiltro);
    } catch (e) { console.error(e); }
}

function selecionarTudoDicionario(checked) {
    document.querySelectorAll('#lista-dicionario input[type="checkbox"]').forEach(cb => {
        // Só seleciona se tiver o atributo data-nome (o robô não deve ter)
        if (cb.hasAttribute('data-nome')) {
            cb.checked = checked;
            const nome = cb.getAttribute('data-nome');
            if (checked) itensSelecionados.add(nome); else itensSelecionados.delete(nome);
        }
    });
    atualizarBotaoMultiplos();
}

function toggleSelecao(nome, checked) {
    if (checked) itensSelecionados.add(nome); else itensSelecionados.delete(nome);
    atualizarBotaoMultiplos();
}

function atualizarBotaoMultiplos() {
    const btn = document.getElementById('btn-adicionar-multiplos');
    if (itensSelecionados.size > 0) {
        btn.classList.remove('hidden');
        btn.className = "fixed bottom-6 right-6 z-50 bg-green-600 text-white px-6 py-3 rounded-full text-xs font-black shadow-2xl animate-bounce";
        btn.innerText = `🛒 ADICIONAR ${itensSelecionados.size} ITENS`;
    } else {
        btn.classList.add('hidden');
    }
}

async function enviarSelecionadosParaLista() {
    const btn = document.getElementById('btn-adicionar-multiplos');
    if (itensSelecionados.size === 0) return;
    btn.innerText = "ADICIONANDO..."; btn.disabled = true;
    try {
        for (let nome of itensSelecionados) {
            await fetch('/api/GerenciarLista', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome: nome.toUpperCase(), quantidade: 1 }) });
        }
        itensSelecionados.clear();
        btn.disabled = false; btn.classList.add('hidden');
        alert("Itens adicionados!");
        alternarAba('lista');
    } catch (e) { console.error(e); }
}

window.salvarAlteracoesItem = async (id, elemento) => {
    const container = elemento.closest('.item-dicionario-lista');
    const monitorar = container.querySelector('.toggle-monitorar').checked;
    const preco_alvo = container.querySelector('.input-alvo').value.replace(',', '.'); // Permite virgula e arruma
    const ean = container.querySelector('.input-ean').value.trim();

    container.style.opacity = '0.5';
    try {
        await fetch('/api/GerenciarDicionario', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, monitorar, preco_alvo: parseFloat(preco_alvo), ean })
        });
        if (ean === '') { container.classList.add('border-orange-300', 'bg-orange-50'); container.classList.remove('bg-white'); } 
        else { container.classList.remove('border-orange-300', 'bg-orange-50'); container.classList.add('bg-white'); }
    } catch (e) { alert("Erro ao salvar!"); } finally { container.style.opacity = '1'; }
};

window.limparTodaMonitoracao = async () => {
    if (confirm("DESLIGAR O ROBÔ para todos os itens?")) {
        try {
            await fetch('/api/GerenciarDicionario', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'desmarcar_todos' }) });
            document.querySelectorAll('.toggle-monitorar').forEach(c => c.checked = false);
            alert("Robô desligado!");
        } catch (e) { console.error(e); }
    }
};

async function iniciarScannerEAN(botaoClicado) {
    const container = document.createElement('div');
    container.id = "scanner-container";
    container.className = "fixed inset-0 z-[100] bg-black flex flex-col";
    container.innerHTML = `<div id="reader" class="w-full h-full"></div><button onclick="document.getElementById('scanner-container').remove()" class="absolute top-4 right-4 bg-white p-2 rounded">Fechar</button>`;
    document.body.appendChild(container);

    const html5QrCode = new Html5Qrcode("reader");
    html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 250, height: 100 } }, (decodedText) => {
        const inputEan = botaoClicado.parentElement.querySelector('.input-ean');
        inputEan.value = decodedText;
        inputEan.dispatchEvent(new Event('change'));
        html5QrCode.stop();
        document.getElementById('scanner-container').remove();
    }, (err) => { }).catch(e => alert("Erro câmera"));
}

// ============================================================================
// 10. NOTAS FISCAIS (PROCESSAR URL E VINCULAR)
// ============================================================================
async function processarUrlManual() {
    const urlInput = document.getElementById('url-input');
    const url = urlInput.value.trim();
    if (!url) return;
    const statusDiv = document.getElementById('status');
    statusDiv.classList.remove('hidden'); statusDiv.innerText = "📡 Analisando nota...";
    try {
        let response = await fetch('/api/ProcessarNota', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, consulta: true }) });
        let resData = await response.json();
        let apelidoFinal = resData.estabelecimento;
        if (!resData.jaConhecido || /LTDA|S\.A|DISTRIBUIDORA/i.test(apelidoFinal)) {
            const novo = prompt(`Nome limpo para a loja (CNPJ: ${resData.cnpj}):`, apelidoFinal);
            if (novo) apelidoFinal = novo.toUpperCase(); else return statusDiv.innerText = "Cancelado.";
        }
        statusDiv.innerText = "💾 Salvando...";
        response = await fetch('/api/ProcessarNota', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, apelido: apelidoFinal }) });
        resData = await response.json();
        statusDiv.innerText = `✅ Salvo: ${resData.estabelecimento}`;
        urlInput.value = '';
        renderPreview(resData.dados);
        carregarLista();
    } catch (err) { statusDiv.innerText = "❌ Erro ao processar."; }
}

async function renderPreview(dados) {
    const preview = document.getElementById('preview-container');
    const listaItens = document.getElementById('lista-itens');
    listaItens.innerHTML = ''; preview.classList.remove('hidden');
    const dicionario = await fetch('/api/VincularProdutos').then(r => r.json());
    listaItens.innerHTML = `<div class="p-4 bg-blue-50 border-b"><p class="text-xs font-bold uppercase">${dados.estabelecimento}</p><p class="text-sm font-black text-blue-600">Total: R$ ${dados.valor_total.toFixed(2)}</p></div>`;
    
    dados.itens.forEach(item => {
        const pV = dicionario.find(p => p.ids_vinculados?.includes(item.id_interno));
        const ok = !!pV;
        listaItens.innerHTML += `
            <div class="flex justify-between items-center p-3 border-b">
                <div class="flex-1 pr-2"><p class="text-[11px] font-bold ${ok ? 'text-gray-800' : 'text-orange-500'} uppercase">${ok ? pV.nome_comum : item.descricao}</p>
                <p class="text-[10px] text-blue-600">${item.quantidade}x R$ ${item.preco_unitario.toFixed(2)}</p></div>
                <button onclick="vincularID('${item.id_interno}', '${escapeHTML(item.descricao)}')" class="ml-2 p-2 ${ok ? 'bg-gray-100' : 'bg-orange-500 text-white'} rounded-full">${ok ? '✔️' : '✏️'}</button>
            </div>`;
    });
}

function vincularID(id, desc) {
    const nomeSugerido = desc.split('*')[0].trim().toUpperCase();
    const novoNome = prompt(`Nome padrão para "${desc}":`, nomeSugerido);
    if (!novoNome) return;
    const cat = prompt(`Categoria:`, sugerirCategoria(novoNome.toUpperCase()));
    if (!cat) return;
    fetch('/api/VincularProdutos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idPrincipal: id, nomePadrao: novoNome.trim().toUpperCase(), categoria: cat.toUpperCase(), fotoUrl: prompt(`URL da Foto:`, "") }) })
        .then(() => { processarUrlManual(); renderizarDicionario(); });
}

function sugerirCategoria(nome) {
    if (nome.match(/QUEIJO|IOGURTE|MANTEIGA/)) return "FRIOS E CONGELADOS";
    if (nome.match(/DETERGENTE|SABAO|AMACIANTE/)) return "LIMPEZA";
    if (nome.match(/CERVEJA|REFRIGERANTE|SUCO/)) return "BEBIDAS";
    if (nome.match(/CARNE|FRANGO|LINGUICA/)) return "AÇOUGUE";
    if (nome.match(/ARROZ|FEIJAO|OLEO/)) return "MERCEARIA";
    return "OUTROS";
}

// ============================================================================
// 11. FILTROS E AUTOCOMPLETE
// ============================================================================
async function carregarSugestoes() {
    try {
        const produtos = await fetch('/api/VincularProdutos').then(r => r.json());
        const dl = document.getElementById('sugestoes-produtos');
        if (dl) dl.innerHTML = [...new Set(produtos.map(p => p.nome_comum))].map(n => `<option value="${n.toUpperCase()}">`).join('');
    } catch (e) { }
}

async function hidratarPrecosTemporarios() {
    try {
        const dados = await fetch('/api/GerenciarPrecosTemp').then(r => r.json());
        if (dados && dados.length > 0) {
            window.precosDigitadosNoMercado = {};
            dados.forEach(reg => {
                if (!window.precosDigitadosNoMercado[reg.item]) window.precosDigitadosNoMercado[reg.item] = {};
                window.precosDigitadosNoMercado[reg.item][reg.loja] = reg.preco;
            });
            recalcularRankingLive();
        }
    } catch (e) { }
}

function renderizarFiltrosCategorias() {
    const secaoFiltros = document.getElementById('secao-filtros-categorias');
    const container = document.getElementById('container-categorias-filtro');
    if (!container || !secaoFiltros) return;

    const corredores = ["TUDO", "HORTIFRUTI", "FRIOS E CONGELADOS", "MERCEARIA", "AÇOUGUE E PEIXARIA", "BEBIDAS", "LIMPEZA", "HIGIENE E PERFUMARIA", "PADARIA E MATINAIS", "DESCARTÁVEIS E EMBALAGENS", "OUTROS"];
    secaoFiltros.classList.remove('hidden'); container.innerHTML = '';

    corredores.forEach(c => {
        const btn = document.createElement('button');
        btn.className = `px-3 py-1.5 rounded-full text-[10px] font-black uppercase border ${categoriaSelecionadaFiltro === c ? 'bg-blue-600 text-white' : 'bg-white text-gray-500'}`;
        btn.innerText = c === "TUDO" ? "📍 TUDO" : c;
        btn.onclick = () => filtrarPorCorredor(c);
        container.appendChild(btn);
    });
}

function filtrarPorCorredor(idCategoria) {
    categoriaSelecionadaFiltro = idCategoria;
    document.querySelectorAll('#container-categorias-filtro button').forEach(b => {
        b.className = b.innerText.includes(idCategoria) || (idCategoria==="TUDO" && b.innerText==="📍 TUDO") ? "px-3 py-1.5 rounded-full text-[10px] font-black border bg-blue-600 text-white" : "px-3 py-1.5 rounded-full text-[10px] font-black border bg-white text-gray-500";
    });

    document.querySelectorAll('#lista-ativa .header-corredor').forEach(h => { h.classList.toggle('hidden', idCategoria !== "TUDO" && h.getAttribute('data-categoria') !== idCategoria); });
    document.querySelectorAll('#lista-ativa .card-produto-lista').forEach(c => { c.classList.toggle('hidden', idCategoria !== "TUDO" && c.getAttribute('data-categoria-produto') !== idCategoria); });
    document.querySelectorAll('.block-categoria-dicionario').forEach(b => { b.classList.toggle('hidden', idCategoria !== "TUDO" && b.getAttribute('data-categoria-dict') !== idCategoria); });
}

// ============================================================================
// 12. INICIALIZAÇÃO E LOOP DE BACKGROUND
// ============================================================================
setInterval(() => { if (!document.hidden) hidratarPrecosTemporarios(); }, 5000);
renderizarFiltrosCategorias();
carregarLista();
carregarSugestoes();
hidratarPrecosTemporarios();