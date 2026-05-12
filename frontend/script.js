// ================== ESTADO GLOBAL ==================
let totaisPorMercado = {};       // Armazena preços por mercado para pintura de bordas
let itensSelecionados = new Set(); // Checkboxes selecionados no dicionário
let meuGraficoRelatorio = null;   // Instância do gráfico de relatórios
let timeoutPreco, timeoutQtd;     // Debouncers para salvar preço e quantidade
let precosDigitadosNoMercado = {}; // Preços digitados ao vivo (guardados no localStorage)

// ================== FUNÇÕES UTILITÁRIAS ==================

/**
 * Escapa caracteres especiais para uso em atributos HTML.
 * Mais robusto que a versão anterior (escapa aspas duplas e &)
 */
function escapeHTML(str) {
    if (!str) return "";
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Retorna a cor associada ao mercado (usada nos cards de ranking e gráfico).
 */
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

/**
 * Exibe modal com imagem ampliada do produto.
 */
function ampliarImagem(url, nome) {
    if (!url || url.includes('placeholder')) return;
    // Remove modal anterior se existir
    const modalExistente = document.getElementById('modal-foto');
    if (modalExistente) modalExistente.remove();
    
    const modalHtml = `
        <div id="modal-foto" onclick="this.remove()" class="fixed inset-0 bg-black/90 z-[60] flex items-center justify-center p-4">
            <div class="relative w-full max-w-sm"> 
                <img src="${url}" class="w-full h-auto max-h-[70vh] object-contain rounded-2xl shadow-2xl border-4 border-white/10">
                <p class="text-white text-center mt-4 font-bold uppercase tracking-widest text-[10px]">${escapeHTML(nome)}</p>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

// ================== ABAS PRINCIPAIS ==================

/**
 * Alterna entre as abas: Lista, Dicionário, Relatórios.
 */
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

// ================== RELATÓRIOS (GRÁFICO DE GASTOS) ==================

/**
 * Carrega os relatórios (gráfico de gastos por categoria).
 * Filtro por loja opcional.
 */
async function carregarRelatorios() {
    const ctx = document.getElementById('chartCategorias');
    const seletorLoja = document.getElementById('filtro-loja-relatorio');
    const lojaSelecionada = seletorLoja ? seletorLoja.value : "";
    try {
        const url = (lojaSelecionada && lojaSelecionada !== "")
            ? `/api/ObterRelatorioGastos?loja=${encodeURIComponent(lojaSelecionada)}`
            : '/api/ObterRelatorioGastos';
        const response = await fetch(url);
        const dados = await response.json();
        // Preenche o seletor de lojas apenas na primeira vez
        if (seletorLoja && seletorLoja.options.length <= 1) {
            await carregarFiltroLojas();
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
                    if (activeElements.length > 0) {
                        const index = activeElements[0].index;
                        exibirDetalhesCategoria(dados[index]);
                    }
                },
                plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 9, weight: 'bold' } } }
                }
            }
        });
    } catch (e) {
        console.error("Erro ao carregar gráfico:", e);
        mostrarFeedbackErro("Erro ao carregar relatórios.");
    }
}

/**
 * Popula o seletor de lojas (filtro dos relatórios).
 */
async function carregarFiltroLojas() {
    const seletor = document.getElementById('filtro-loja-relatorio');
    if (!seletor) return;
    try {
        const response = await fetch('/api/ListarLojas');
        const lojas = await response.json();
        lojas.forEach(loja => {
            const option = document.createElement('option');
            option.value = loja;
            option.innerText = `🏪 ${loja}`;
            seletor.appendChild(option);
        });
    } catch (e) {
        console.error("Erro ao carregar lojas:", e);
    }
}

/**
 * Exibe a lista detalhada de itens de uma categoria (ao clicar no gráfico).
 */
function exibirDetalhesCategoria(categoria) {
    const container = document.getElementById('lista-gastos-detalhada');
    if (!container) return;
    const detalhesOrdenados = [...categoria.detalhes].sort((a, b) => a.nome.localeCompare(b.nome));
    let html = `
        <div class="mt-6 p-4 bg-blue-50 rounded-2xl border border-blue-100">
            <h4 class="text-[10px] font-black text-blue-600 uppercase mb-3 tracking-widest text-center">
                📦 Detalhes: ${categoria._id}
            </h4>
            <div class="space-y-2">`;
    detalhesOrdenados.forEach(item => {
        const unitario = item.valor / (item.qtd || 1);
        html += `
            <div class="flex justify-between items-center text-[11px] bg-white p-2 rounded-lg shadow-sm">
                <div class="flex flex-col">
                    <span class="text-gray-600 font-bold uppercase truncate pr-2">${escapeHTML(item.nome)}</span>
                    <span class="text-[9px] text-gray-400 font-medium">
                        ${item.qtd}x de R$ ${unitario.toFixed(2)}
                    </span>
                </div>
                <span class="text-blue-700 font-black whitespace-nowrap">R$ ${item.valor.toFixed(2)}</span>
            </div>`;
    });
    html += `</div></div>`;
    container.innerHTML = html;
    container.scrollIntoView({ behavior: 'smooth' });
}

// ================== LISTA DE COMPRAS (ABA) ==================

/**
 * Carrega a lista ativa a partir do backend e renderiza na tela.
 * Ordena por categoria e adiciona os elementos visuais.
 * Ao final, chama a atualização em lote dos preços (ranking + pílulas).
 */
async function carregarLista() {
    totaisPorMercado = {};
    const listaDiv = document.getElementById('lista-ativa');
    listaDiv.innerHTML = '<p class="text-gray-400 text-xs text-center animate-pulse">Sincronizando...</p>';

    try {
        // 1. Chamadas em paralelo para garantir que todos os dados cheguem
        const [respLista, respDict, respPrecos] = await Promise.all([
            fetch('/api/GerenciarLista'),
            fetch('/api/VincularProdutos'),
            fetch('/api/CompararPrecos')
        ]);

        const itens = await respLista.json();
        const dicionario = await respDict.json();
        const dataPrecos = await respPrecos.json();

        // 2. Armazena os preços globalmente
        window.totaisPorMercado = dataPrecos.precosPorLojaCompleto || {};

        if (itens.length === 0) {
            listaDiv.innerHTML = '<p class="text-gray-500 italic text-center py-4">Tudo pronto! 🎉</p>';
            // Esconde o ranking quando não há itens
            const totalizador = document.getElementById('totalizador-estimado');
            if (totalizador) totalizador.classList.add('hidden');
            return;
        }

        // 3. Organiza os itens por categoria
        const itensOrdenados = itens.map(item => {
            const info = dicionario.find(p => p.nome_comum === item.item_nome) || {};
            return { ...item, categoria: info.categoria || "OUTROS" };
        });
        itensOrdenados.sort((a, b) => a.categoria.localeCompare(b.categoria));

        listaDiv.innerHTML = '';
        let categoriaAtual = "";

        // 4. Loop de renderização (monta os cards)
        itensOrdenados.forEach(item => {
            if (item.categoria !== categoriaAtual) {
                categoriaAtual = item.categoria;
                const separador = document.createElement('div');
                separador.className = "text-[10px] font-black text-blue-500 mt-4 mb-2 uppercase tracking-widest border-l-4 border-blue-500 pl-2 bg-blue-50/50 py-1 rounded-r";
                separador.innerHTML = `📍 Corredor: ${categoriaAtual}`;
                listaDiv.appendChild(separador);
            }

            const infoDict = dicionario.find(p => p.nome_comum === item.item_nome) || {};
            const idFormatado = item.item_nome.replace(/\s+/g, '-');
            const nomeSeguro = escapeHTML(item.item_nome);
            const nomeBusca = item.item_nome.trim().toUpperCase();
            const isComprado = item.comprado === true;
            const qtd = item.quantidade || 1;
            const precoReal = item.preco_real || '';

            const itemElement = document.createElement('div');
            // Inicia com borda neutra; será pintada depois por pintarBordasDeCobertura
            itemElement.className = `bg-white p-2 rounded-xl border border-blue-50 shadow-sm mb-2 flex items-center gap-3 ${isComprado ? 'item-comprado opacity-60' : ''}`;
            itemElement.setAttribute('data-produto', nomeBusca);

            itemElement.innerHTML = `
                <div class="w-12 h-12 shrink-0 overflow-hidden rounded-lg border border-gray-100 bg-gray-50 cursor-pointer" 
                     onclick="ampliarImagem('${infoDict.foto_url || 'https://via.placeholder.com/50'}', '${nomeSeguro}')">
                    <img src="${infoDict.foto_url || 'https://via.placeholder.com/50'}" class="w-full h-full object-cover">
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex justify-between items-start">
                        <span class="nome-item font-bold text-gray-700 uppercase text-[10px] break-words cursor-pointer hover:text-blue-600" onclick="abrirGrafico('${nomeSeguro}')">
                            ${escapeHTML(item.item_nome)}
                        </span>
                        <div class="relative flex items-center gap-1 bg-blue-50/50 p-1 rounded-lg">
                            <div id="alerta-${idFormatado}" class="absolute -top-5 right-0 z-10 pointer-events-none"></div>
                            <input type="number" min="1" value="${qtd}" 
                                class="input-qtd-real w-8 p-0 text-[10px] font-black text-blue-700 bg-transparent border-none text-center outline-none"
                                oninput="calcularTotalReal(); agendarSalvarQtd('${nomeSeguro}', this.value)">
                            <span class="text-[8px] text-blue-400">x</span>
                            <input type="number" step="0.01" value="${precoReal}" placeholder="0,00"
                                oninput="calcularTotalReal(); salvarPrecoNoBanco('${nomeSeguro}', this.value); verificarAlertaPreco('${nomeSeguro}', this.value, document.getElementById('alerta-${idFormatado}'))" 
                                class="input-preco-real w-14 p-1 text-[10px] border border-blue-200 rounded text-center outline-none focus:ring-1 focus:ring-blue-500">
                            <button onclick="alternarStatus('${nomeSeguro}', ${!isComprado})" class="text-lg ml-1 active:scale-90 transition-transform">
                                ${isComprado ? '🔄' : '✅'}
                            </button>
                            <button onclick="deletarItem('${nomeSeguro}')" class="text-xs ml-1 hover:bg-red-100 rounded p-1">🗑️</button>
                        </div>
                    </div>
                    <div id="preco-lista-${idFormatado}"></div>
                </div>`;

            listaDiv.appendChild(itemElement);

            if (precoReal) {
                verificarAlertaPreco(item.item_nome, precoReal, document.getElementById(`alerta-${idFormatado}`));
            }
        });

        // 5. Dispara a pintura das bordas (cobertura de preços) e atualiza ranking/pílulas
        // Usamos setTimeout para garantir que o DOM esteja pronto
        setTimeout(() => {
            pintarBordasDeCobertura(window.totaisPorMercado);
            atualizarRankingEPilulasOtimizado();
            calcularTotalReal();
        }, 300);

    } catch (err) {
        console.error("Erro ao carregar lista:", err);
        const listaDiv = document.getElementById('lista-ativa');
        if (listaDiv) {
            listaDiv.innerHTML = '<p class="text-red-500 text-center py-4">Erro ao carregar lista. Tente novamente.</p>';
        }
        mostrarFeedbackErro("Falha ao carregar lista.");
    }
}

/**
 * Busca em lote o melhor preço histórico de cada item e atualiza o ranking.
 * Agora usa o elemento correto "totalizador-estimado".
 */
async function atualizarRankingEPilulasOtimizado() {
    const container = document.getElementById('totalizador-estimado');
    if (!container) return;

    try {
        const response = await fetch('/api/CompararPrecos');
        const data = await response.json();

        if (!data.ranking || data.ranking.length === 0) {
            container.classList.add('hidden');
            return;
        }

        container.classList.remove('hidden');
        // Monta o HTML do ranking
        let html = `<p class="text-[9px] font-black text-blue-500 uppercase tracking-widest mb-3 text-center">📊 Comparativo em Tempo Real</p>
                    <div class="flex gap-2 overflow-x-auto pb-2 no-scrollbar">`;
        
        data.ranking.forEach((loja, index) => {
            const cor = obterCorMercado(loja.nome);
            const isVencedor = index === 0;
            html += `
                <div class="min-w-[130px] p-2 rounded-xl border-l-4 ${isVencedor ? 'border-green-500 bg-green-50' : 'border-gray-200 bg-white'} shadow-sm transition-all">
                    <p class="text-[7px] font-black text-gray-400 uppercase truncate">${escapeHTML(loja.nome)}</p>
                    <p class="text-sm font-black ${isVencedor ? 'text-green-600' : 'text-gray-700'}">R$ ${loja.total.toFixed(2)}</p>
                    <p class="text-[6px] font-bold text-gray-500">${loja.encontrados}/${loja.totalItens} itens</p>
                </div>`;
        });
        html += `</div>`;
        container.innerHTML = html;

        // Preenche as pílulas individuais de melhor preço histórico abaixo de cada item
        if (data.precosIndividuais) {
            Object.keys(data.precosIndividuais).forEach(nomeItem => {
                const idFormatado = nomeItem.replace(/\s+/g, '-');
                const el = document.getElementById(`preco-lista-${idFormatado}`);
                if (el) {
                    const info = data.precosIndividuais[nomeItem];
                    el.innerHTML = `
                        <div class="mt-1 text-[9px] bg-emerald-50 text-emerald-700 p-1 px-2 rounded-lg border border-emerald-200 flex justify-between items-center shadow-sm">
                            <span>💡 Menor Preço Histórico: ${escapeHTML(info.loja)}</span>
                            <span class="font-black">R$ ${info.valor.toFixed(2)}</span>
                        </div>`;
                }
            });
        }

        // Recarrega os preços digitados ao vivo (do localStorage)
        carregarPrecosLive();
        recalcularRankingLive(data.ranking);
    } catch (e) {
        console.error("Erro ao atualizar ranking e pílulas:", e);
    }
}

// ================== PREÇOS DIGITADOS AO VIVO ==================

/**
 * Carrega do localStorage os preços digitados pelo usuário.
 */
function carregarPrecosLive() {
    const stored = localStorage.getItem('precosLive');
    if (stored) {
        try {
            precosDigitadosNoMercado = JSON.parse(stored);
        } catch (e) {}
    }
}

/**
 * Registra um preço digitado ao vivo para determinado produto e loja.
 * Salva no localStorage e atualiza ranking.
 */
function registrarPrecoLive(nome, rede, valor) {
    if (!precosDigitadosNoMercado[nome]) precosDigitadosNoMercado[nome] = {};
    precosDigitadosNoMercado[nome][rede] = parseFloat(valor) || null;
    localStorage.setItem('precosLive', JSON.stringify(precosDigitadosNoMercado));
    // Recalcula ranking com os novos preços
    fetch('/api/CompararPrecos')
        .then(res => res.json())
        .then(data => recalcularRankingLive(data.ranking))
        .catch(e => console.error("Erro ao recalcular ranking live:", e));
}

/**
 * Recalcula o ranking com base nos preços digitados ao vivo (sobrescreve os históricos).
 * Atualiza o container "totalizador-estimado".
 */
function recalcularRankingLive(rankingBase) {
    const container = document.getElementById('totalizador-estimado');
    if (!container || !rankingBase) return;

    let novoRanking = rankingBase.map(loja => {
        let totalLive = 0;
        let encontrados = 0;
        // Para cada produto com preço digitado, soma se a loja corresponde
        Object.keys(precosDigitadosNoMercado).forEach(nomeItem => {
            const precosDoItem = precosDigitadosNoMercado[nomeItem];
            const redeChave = Object.keys(precosDoItem).find(k => loja.nome.toUpperCase().includes(k));
            if (redeChave && precosDoItem[redeChave]) {
                totalLive += precosDoItem[redeChave];
                encontrados++;
            }
        });
        if (totalLive === 0) return loja;
        return { ...loja, total: totalLive, encontrados: encontrados, isLive: true };
    });

    novoRanking.sort((a, b) => a.total - b.total);

    let html = `<p class="text-[9px] font-black text-blue-500 uppercase tracking-widest mb-3 text-center">📊 Comparativo em Tempo Real</p>
                <div class="flex gap-2 overflow-x-auto pb-2 no-scrollbar">`;
    novoRanking.forEach(loja => {
        const corCard = loja.isLive ? 'border-blue-500 bg-blue-50/20' : 'border-gray-200 bg-white';
        html += `
            <div class="min-w-[130px] p-2 rounded-xl border-l-4 ${corCard} shadow-sm transition-all">
                <p class="text-[7px] font-black text-gray-400 uppercase truncate">${escapeHTML(loja.nome)}</p>
                <p class="text-sm font-black ${loja.isLive ? 'text-blue-600' : 'text-gray-700'}">R$ ${loja.total.toFixed(2)}</p>
                <p class="text-[6px] font-bold text-gray-500">${loja.isLive ? 'Digitado Agora' : 'Dados do Banco'}</p>
            </div>`;
    });
    html += `</div>`;
    container.innerHTML = html;
}

// ================== CÁLCULO DO TOTAL REAL ==================

/**
 * Soma os preços reais (inputs) da lista e atualiza o total na tela.
 */
function calcularTotalReal() {
    let total = 0;
    const cards = document.querySelectorAll('#lista-ativa > div');
    cards.forEach(card => {
        const inputPreco = card.querySelector('.input-preco-real');
        const inputQtd = card.querySelector('.input-qtd-real');
        if (inputPreco && inputQtd) {
            const preco = parseFloat(inputPreco.value) || 0;
            const qtd = parseFloat(inputQtd.value) || 1;
            total += (preco * qtd);
        }
    });
    const display = document.getElementById('total-real-dinamico');
    if (display) display.innerText = `R$ ${total.toFixed(2).replace('.', ',')}`;
}

/**
 * Salva o preço informado no banco (debounced).
 */
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

/**
 * Salva a quantidade informada no banco (debounced) e atualiza ranking/pílulas.
 * Evita recarregar a lista inteira.
 */
function agendarSalvarQtd(nome, qtd) {
    clearTimeout(timeoutQtd);
    timeoutQtd = setTimeout(async () => {
        try {
            await fetch('/api/GerenciarLista', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nome: nome.toUpperCase(), quantidade: parseInt(qtd) || 1 })
            });
            // Atualiza apenas ranking e pílulas, sem recarregar toda a lista
            await atualizarRankingEPilulasOtimizado();
            calcularTotalReal();
        } catch (e) { console.error(e); }
    }, 1000);
}

// ================== GRÁFICO DE HISTÓRICO DO PRODUTO ==================

/**
 * Abre o modal do gráfico com botões de filtro de período.
 * Remove qualquer modal existente antes de criar.
 */
async function abrirGrafico(nome) {
    // Remove modal antigo se existir
    const modalExistente = document.getElementById('modal-grafico');
    if (modalExistente) modalExistente.remove();

    const nomeSeguro = escapeHTML(nome);
    let canvasHtml = `
    <div id="modal-grafico" class="fixed inset-0 bg-black/80 z-[60] p-4 flex flex-col justify-center">
        <div class="bg-white rounded-3xl p-6 w-full max-w-lg shadow-2xl animate-fade-in">
            <div class="flex justify-between items-start mb-4">
                <div>
                    <p class="text-[10px] font-black text-blue-400 uppercase tracking-[0.2em]">Histórico de Preços</p>
                    <h3 class="text-sm font-black text-gray-800 uppercase leading-tight">${nomeSeguro}</h3>
                </div>
                <button onclick="document.getElementById('modal-grafico').remove()" class="bg-red-50 text-red-500 rounded-full w-8 h-8 flex items-center justify-center font-bold shadow-sm active:scale-90">✕</button>
            </div>
            <div class="flex gap-2 mb-6 justify-center" id="filtros-grafico">
                <button onclick="filtrarPeriodoGrafico('${encodeURIComponent(nome)}', 7, this)" class="btn-filtro flex-1 py-2 bg-gray-100 text-[9px] font-black rounded-xl hover:bg-blue-50 transition-all">7D</button>
                <button onclick="filtrarPeriodoGrafico('${encodeURIComponent(nome)}', 30, this)" class="btn-filtro flex-1 py-2 bg-gray-100 text-[9px] font-black rounded-xl hover:bg-blue-50 transition-all">30D</button>
                <button onclick="filtrarPeriodoGrafico('${encodeURIComponent(nome)}', 90, this)" class="btn-filtro flex-1 py-2 bg-gray-100 text-[9px] font-black rounded-xl hover:bg-blue-50 transition-all">90D</button>
                <button onclick="filtrarPeriodoGrafico('${encodeURIComponent(nome)}', 0, this)" class="btn-filtro flex-1 py-2 bg-blue-600 text-white text-[9px] font-black rounded-xl shadow-md">TUDO</button>
            </div>
            <div class="relative h-64">
                <canvas id="meuGrafico"></canvas>
            </div>            
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', canvasHtml);
    await filtrarPeriodoGrafico(nome, 0); // Carrega "Tudo" inicialmente
}

/**
 * Atualiza os dados do gráfico e exibe detalhes do mercado no tooltip.
 */
async function filtrarPeriodoGrafico(nome, dias, btn = null) {
    // Estilo visual dos botões de filtro
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

        const response = await fetch(url);
        const dados = await response.json();

        const ctx = document.getElementById('meuGrafico');
        if (!ctx) return;
        let chartInstance = Chart.getChart(ctx);

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
                    legend: { display: false },
                    tooltip: {
                        enabled: true,
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        padding: 10,
                        titleFont: { size: 10 },
                        bodyFont: { size: 12, weight: 'bold' },
                        callbacks: {
                            label: (context) => `R$ ${context.parsed.y.toFixed(2)}`,
                            afterLabel: (context) => `Loja: ${dados[context.dataIndex].mercado}`
                        }
                    }
                },
                scales: {
                    y: { beginAtZero: false, grid: { color: '#f3f4f6' }, ticks: { font: { size: 9 } } },
                    x: { grid: { display: false }, ticks: { font: { size: 8 } } }
                }
            }
        };

        if (chartInstance) {
            chartInstance.data = config.data;
            chartInstance.options = config.options;
            chartInstance.update();
        } else {
            new Chart(ctx, config);
        }
    } catch (e) {
        console.error("Erro ao carregar gráfico filtrado:", e);
        mostrarFeedbackErro("Não foi possível carregar o histórico.");
    }
}

// ================== DICIONÁRIO (CATÁLOGO) ==================

/**
 * Renderiza o dicionário de produtos, agrupado por categoria,
 * com checkboxes e botão de adicionar individual.
 */
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
                        <div class="flex-1"><p class="text-[10px] font-bold text-gray-800 uppercase">${escapeHTML(prod.nome_comum)}</p></div>
                        <button onclick="adicionarDiretoALista('${nomeSeguro}')" class="bg-blue-50 text-blue-600 px-3 py-2 rounded-lg text-xs font-bold active:scale-90">🛒+</button>
                    </div>`;
            });
            container.appendChild(div);
        }
    } catch (e) {
        console.error(e);
        container.innerHTML = '<p class="text-red-500 text-center p-4">Erro ao carregar catálogo.</p>';
    }
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
        btn.className = "fixed bottom-6 right-6 z-50 bg-green-600 text-white px-6 py-3 rounded-full text-xs font-black shadow-2xl animate-bounce border-2 border-white";
        btn.innerText = `🛒 ADICIONAR ${contador} ITENS`;
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
        itensSelecionados.clear();
        btn.disabled = false;
        btn.classList.add('hidden');
        alert(`${total} itens adicionados com sucesso!`);
        alternarAba('lista');
    } catch (e) {
        console.error(e);
        btn.disabled = false;
        btn.innerText = `ADICIONAR ${itensSelecionados.size} ITENS`;
        mostrarFeedbackErro("Erro ao adicionar itens.");
    }
}

// ================== MANIPULAÇÃO MANUAL DA LISTA ==================

async function alternarStatus(nome, novoStatus) {
    try {
        await fetch('/api/GerenciarLista', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: nome.toUpperCase(), comprado: novoStatus })
        });
        carregarLista();
    } catch (e) {
        console.error(e);
        mostrarFeedbackErro("Erro ao alterar status.");
    }
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
    } catch (e) {
        console.error(e);
        mostrarFeedbackErro("Erro ao adicionar item.");
    }
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
    } catch (e) {
        console.error(e);
        mostrarFeedbackErro("Erro ao adicionar item.");
    }
}

// ================== NOTA FISCAL (COM MODO CONSULTA) ==================

async function processarUrlManual() {
    const urlInput = document.getElementById('url-input');
    const url = urlInput.value.trim();
    if (!url) return;
    const statusDiv = document.getElementById('status');
    statusDiv.classList.remove('hidden');
    statusDiv.innerText = "📡 Analisando CNPJ da nota...";
    try {
        // 1. Consulta apenas (não salva) para obter CNPJ e estabelecimento sugerido
        let response = await fetch('/api/ProcessarNota', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url, consulta: true })
        });
        let resData = await response.json();
        let apelidoFinal = resData.estabelecimento;
        const ehNomeJuridico = /LTDA|S\.A|S\/A|DISTRIBUIDORA/i.test(apelidoFinal);
        if (!resData.jaConhecido || ehNomeJuridico) {
            const novoApelido = prompt(`Nova unidade (CNPJ: ${resData.cnpj}). Como quer chamar esta loja?`, apelidoFinal);
            if (novoApelido) {
                apelidoFinal = novoApelido.toUpperCase();
            } else if (ehNomeJuridico) {
                statusDiv.innerText = "⚠️ Processamento cancelado: Defina um apelido.";
                return;
            }
        }
        // 2. Agora sim, envia para salvar com o apelido definido
        statusDiv.innerText = "💾 Salvando dados...";
        response = await fetch('/api/ProcessarNota', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url, apelido: apelidoFinal })
        });
        resData = await response.json();
        statusDiv.innerText = `✅ Processado: ${resData.estabelecimento}`;
        urlInput.value = '';
        renderPreview(resData.dados);
        carregarLista();
        // Atualiza também o gráfico de relatórios se estiver visível
        if (!document.getElementById('secao-relatorios').classList.contains('hidden')) {
            carregarRelatorios();
        }
    } catch (err) {
        console.error(err);
        statusDiv.innerText = "❌ Erro ao processar nota.";
        mostrarFeedbackErro("Falha no processamento da nota.");
    }
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
            <div><p class="text-[10px] font-black text-blue-400 uppercase tracking-widest">Estabelecimento</p><p class="text-xs font-bold text-gray-800 uppercase">${escapeHTML(dados.estabelecimento || "DESCONHECIDO")}</p></div>
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
            <p class="text-[11px] font-bold ${temNomeAmigavel ? 'text-gray-800' : 'text-orange-500'} uppercase leading-tight">
                ${escapeHTML(temNomeAmigavel ? produtoVinculado.nome_comum : item.descricao)}
            </p>
            <div class="flex flex-wrap gap-2 mt-1 items-center">
                <span class="text-[8px] px-1 rounded font-bold ${temNomeAmigavel ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'} uppercase">
                    ${temNomeAmigavel ? 'ID Vinculado' : 'ID Novo'}
                </span>
                <span class="text-[8px] px-1 rounded font-bold ${temFoto ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'} uppercase">
                    ${temFoto ? 'Com Foto' : 'Sem Foto'}
                </span>
                <p class="text-[10px] font-black text-blue-600">${qtd}x R$ ${precoUnitario.toFixed(2)} = <span class="text-blue-800">R$ ${precoTotalItem.toFixed(2)}</span></p>
            </div>
        </div>
        <button onclick="vincularID('${item.id_interno}', '${escapeHTML(item.descricao)}')" 
            class="ml-2 p-3 ${(temNomeAmigavel && temFoto) ? 'bg-gray-100 text-gray-400' : 'bg-orange-500 text-white animate-pulse'} rounded-full shadow-sm active:scale-90 transition-transform">
            ${(temNomeAmigavel && temFoto) ? '✔️' : '✏️'}
        </button>`;
        listaItens.appendChild(itemDiv);
    });
}

function vincularID(id, desc) {
    const nomeSugerido = desc.split('*')[0].trim().toUpperCase();
    const novoNome = prompt(`Nome padrão para "${desc}":`, nomeSugerido);
    if (novoNome === null) return;
    const nomeFinal = novoNome.trim().toUpperCase();
    const categoriaSugerida = sugerirCategoria(nomeFinal);
    const cat = prompt(`Categoria:`, categoriaSugerida);
    if (cat === null) return;
    const foto = prompt(`URL da Foto (Deixe vazio para manter a atual):`, "");
    fetch('/api/VincularProdutos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            idPrincipal: id,
            nomePadrao: nomeFinal,
            categoria: cat.toUpperCase(),
            fotoUrl: foto
        })
    }).then(() => {
        processarUrlManual();
        renderizarDicionario();
    }).catch(e => {
        console.error(e);
        mostrarFeedbackErro("Erro ao vincular produto.");
    });
}

// ================== ALERTA DE PREÇO E SUGESTÕES ==================

/**
 * Compara o preço digitado com a média histórica do produto e exibe um badge.
 */
async function verificarAlertaPreco(nome, precoAtual, elementoDestino) {
    if (!precoAtual || precoAtual <= 0) {
        elementoDestino.innerHTML = '';
        return;
    }
    try {
        const response = await fetch(`/api/ObterHistoricoProduto?nome=${encodeURIComponent(nome)}`);
        const historico = await response.json();
        if (!historico || historico.length === 0) return;
        const soma = historico.reduce((acc, h) => acc + h.preco, 0);
        const media = soma / historico.length;
        const diff = ((precoAtual - media) / media) * 100;
        let badge = "";
        if (diff < -5) {
            badge = `<span class="bg-green-500 text-white text-[8px] px-1 rounded animate-bounce">🔥 BOM PREÇO</span>`;
        } else if (diff > 5) {
            badge = `<span class="bg-red-500 text-white text-[8px] px-1 rounded">⚠️ CARO (Média: R$ ${media.toFixed(2)})</span>`;
        } else {
            badge = `<span class="bg-blue-400 text-white text-[8px] px-1 rounded">⚖️ NA MÉDIA</span>`;
        }
        elementoDestino.innerHTML = badge;
    } catch (e) {
        console.error("Erro no alerta de preço", e);
    }
}

/**
 * Sugere uma categoria com base no nome do produto (palavras-chave).
 */
function sugerirCategoria(nome) {
    const palavras = nome.toUpperCase();
    if (palavras.match(/QUEIJO|IOGURTE|MANTEIGA|REQUEIJAO|DANONE/)) return "FRIOS E CONGELADOS";
    if (palavras.match(/PÃO|ATUM|BISCOITO|GELEIA|LEITE|AVEIA|TORRADA/)) return "PADARIA E MATINAIS";
    if (palavras.match(/DETERGENTE|SABAO|AMACIANTE|DESINFETANTE|VEJA|LIMP/)) return "LIMPEZA";
    if (palavras.match(/CERVEJA|REFRIGERANTE|SUCO|AGUA|VINHO|COCA/)) return "BEBIDAS";
    if (palavras.match(/COPO DESCARTAVEL|PAPEL TOALHA|SACOLA/)) return "DESCARTÁVEIS E EMBALAGENS";
    if (palavras.match(/CARNE|FRANGO|LINGUICA|SALSICHA|COXA|PICANHA/)) return "AÇOUGUE";
    if (palavras.match(/CAFÉ|ARROZ|FEIJAO|MACARRAO|OLEO|ACUCAR|SAL|FARINHA/)) return "MERCEARIA";
    if (palavras.match(/SHAMPOO|CONDICIONADOR|SABONETE|CREME|PASTA/)) return "HIGIENE";
    if (palavras.match(/BANANA|MACA|LARANJA|CEBOLA|BATATA|ALHO/)) return "HORTIFRUTI";
    if (palavras.match(/SACO|VASSOURA|RODO/)) return "UTILIDADES DOMÉSTICAS";
    return "OUTROS";
}

async function carregarSugestoes() {
    try {
        const response = await fetch('/api/VincularProdutos');
        const produtos = await response.json();
        const datalist = document.getElementById('sugestoes-produtos');
        if (datalist) {
            datalist.innerHTML = [...new Set(produtos.map(p => p.nome_comum))]
                .map(nome => `<option value="${escapeHTML(nome.toUpperCase())}">`).join('');
        }
    } catch (e) {
        console.error(e);
    }
}

// ================== EXCLUSÃO E FINALIZAÇÃO ==================

async function deletarItem(nome) {
    if (!confirm(`Remover ${nome} da lista?`)) return;
    try {
        await fetch(`/api/GerenciarLista?nome=${encodeURIComponent(nome)}`, { method: 'DELETE' });
        // Remove preços digitados ao vivo associados a este item
        if (precosDigitadosNoMercado && precosDigitadosNoMercado[nome]) {
            delete precosDigitadosNoMercado[nome];
            localStorage.setItem('precosLive', JSON.stringify(precosDigitadosNoMercado));
        }
        carregarLista();
    } catch (e) {
        console.error("Erro ao deletar item:", e);
        mostrarFeedbackErro("Erro ao remover item.");
    }
}

async function finalizarCompra() {
    if (!confirm("Deseja limpar toda a lista?")) return;
    try {
        await fetch('/api/GerenciarLista', { method: 'DELETE' });
        // Limpa todos os preços digitados ao vivo
        precosDigitadosNoMercado = {};
        localStorage.removeItem('precosLive');
        const display = document.getElementById('total-real-dinamico');
        if (display) display.innerText = "R$ 0,00";
        const totalizador = document.getElementById('totalizador-estimado');
        if (totalizador) totalizador.classList.add('hidden');
        carregarLista();
    } catch (e) {
        console.error("Erro ao finalizar compra:", e);
        mostrarFeedbackErro("Erro ao finalizar compra.");
    }
}

// ================== RELATÓRIOS ADICIONAIS (TOP ITENS, MÉDIAS) ==================

async function renderizarRankingTopCompras() {
    const container = document.getElementById('lista-gastos-detalhada');
    if (!container) return;
    container.innerHTML = '<p class="text-center text-gray-400 text-[10px] animate-pulse py-8">CALCULANDO SEU CONSUMO...</p>';
    try {
        const response = await fetch('/api/ObterRankingTopCompras');
        const dados = await response.json();
        let html = `
            <div class="mt-8">
                <h3 class="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-4 text-center">
                    🏆 TOP 10 PRODUTOS (VOLUME)
                </h3>
                <div class="space-y-2">`;
        dados.forEach((item, index) => {
            html += `
    <div onclick="abrirGrafico('${encodeURIComponent(item._id)}')" 
         class="bg-white p-3 rounded-2xl border border-gray-100 shadow-sm flex items-center gap-4 cursor-pointer hover:bg-blue-50 transition-colors">
        <span class="text-lg font-black text-blue-200">#${index + 1}</span>
        <img src="${item.foto || 'https://via.placeholder.com/50'}" class="w-10 h-10 rounded-lg object-cover bg-gray-50">
        <div class="flex-1">
            <p class="text-[10px] font-black text-gray-700 uppercase">${escapeHTML(item._id)}</p>
            <p class="text-[9px] text-gray-400 font-bold">${item.vezesComprado} notas fiscais</p>
        </div>
        <div class="text-right">
            <p class="text-sm font-black text-blue-600">${item.totalQtd} un</p>
            <p class="text-[8px] text-gray-400">R$ ${item.totalGasto.toFixed(2)} total</p>
        </div>
    </div>`;
        });
        html += `</div></div>`;
        container.innerHTML = html;
    } catch (e) {
        console.error("Erro no ranking de volume:", e);
        container.innerHTML = '<p class="text-red-500 text-center p-4">Erro ao carregar ranking.</p>';
    }
}

async function renderizarGraficoMedias() {
    const container = document.getElementById('lista-gastos-detalhada');
    container.innerHTML = '<div class="h-64 w-full"><canvas id="chartMediasTop10"></canvas></div>';
    try {
        const response = await fetch('/api/ObterMediaPrecoTop10');
        const dados = await response.json();
        const ctx = document.getElementById('chartMediasTop10').getContext('2d');
        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: dados.map(d => d._id.split(' ')[0] + '...'),
                datasets: [{
                    label: 'Preço Médio (R$)',
                    data: dados.map(d => d.precoMedio),
                    backgroundColor: 'rgba(54, 162, 235, 0.6)',
                    borderRadius: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: (c) => dados[c[0].dataIndex]._id,
                            label: (c) => `Média: R$ ${c.parsed.y.toFixed(2)}`
                        }
                    }
                }
            }
        });
    } catch (e) {
        console.error(e);
        container.innerHTML = '<p class="text-red-500 text-center p-4">Erro ao carregar gráfico de médias.</p>';
    }
}

// ================== PINTURA DE BORDAS (COBERTURA DE PREÇOS) ==================

function pintarBordasDeCobertura(dadosComparativos) {
    const cards = document.querySelectorAll('[data-produto]');
    cards.forEach(card => {
        const nome = card.getAttribute('data-produto');
        const p = dadosComparativos[nome] || {};
        const chaves = Object.keys(p);
        // Checagem flexível para as redes principais
        const temCRF = chaves.some(k => k.toUpperCase().includes("CARREFOUR") && p[k] !== null);
        const temASA = chaves.some(k => (k.toUpperCase().includes("ASSAI") || k.toUpperCase().includes("ASSAÍ")) && p[k] !== null);
        const temATA = chaves.some(k => k.toUpperCase().includes("ATACADAO") && p[k] !== null);
        const total = [temCRF, temASA, temATA].filter(v => v).length;
        // Remove classes anteriores
        card.classList.remove('border-yellow-400', 'border-red-500', 'border-transparent');
        if (total >= 3) {
            card.classList.add('border-transparent');
        } else if (total === 0) {
            card.classList.add('border-red-500');
        } else {
            card.classList.add('border-yellow-400');
        }
    });
}

// ================== FEEDBACK DE ERRO (VISUAL) ==================

/**
 * Exibe uma mensagem temporária de erro para o usuário.
 */
function mostrarFeedbackErro(mensagem) {
    const div = document.createElement('div');
    div.className = 'fixed bottom-20 left-1/2 transform -translate-x-1/2 bg-red-600 text-white px-4 py-2 rounded-full text-xs font-bold z-50 shadow-lg animate-fade-in';
    div.innerText = mensagem;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 3000);
}

// ================== INICIALIZAÇÃO ==================

// Carrega preços digitados salvos
carregarPrecosLive();
// Carrega lista e sugestões
carregarLista();
carregarSugestoes();