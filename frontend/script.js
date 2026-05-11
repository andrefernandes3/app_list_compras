// ================== ESTADO GLOBAL ==================
let totaisPorMercado = {};
let itensSelecionados = new Set();      // Controle de seleção no dicionário
let meuGraficoRelatorio = null;         // Instância do gráfico de relatórios
let timeoutPreco, timeoutQtd;           // Debouncers para salvar preço e quantidade

// ================== FUNÇÕES UTILITÁRIAS ==================
/**
 * Escapa caracteres especiais para uso em atributos HTML.
 */
function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/'/g, "\\'");
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
    const modalHtml = `
        <div id="modal-foto" onclick="this.remove()" class="fixed inset-0 bg-black/90 z-[60] flex items-center justify-center p-4">
            <div class="relative w-full max-w-sm"> 
                <img src="${url}" class="w-full h-auto max-h-[70vh] object-contain rounded-2xl shadow-2xl border-4 border-white/10">
                <p class="text-white text-center mt-4 font-bold uppercase tracking-widest text-[10px]">${nome}</p>
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
            carregarFiltroLojas();
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
    } catch (e) { console.error("Erro ao carregar gráfico:", e); }
}

/**
 * Popula o seletor de lojas (filtro dos relatórios).
 */
async function carregarFiltroLojas() {
    const seletor = document.getElementById('filtro-loja-relatorio');
    const response = await fetch('/api/ListarLojas');
    const lojas = await response.json();
    lojas.forEach(loja => {
        const option = document.createElement('option');
        option.value = loja;
        option.innerText = `🏪 ${loja}`;
        seletor.appendChild(option);
    });
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
                    <span class="text-gray-600 font-bold uppercase truncate pr-2">${item.nome}</span>
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

        // 4. Loop de renderização
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

            // Aqui ele nasce Amarelo (yellow-400), a função de pintura vai ajustar logo em seguida!
            itemElement.className = `bg-white p-2 rounded-xl border border-blue-50 border-l-4 border-yellow-400 shadow-sm mb-2 flex items-center gap-3 ${isComprado ? 'item-comprado opacity-60' : ''}`;
            itemElement.setAttribute('data-produto', nomeBusca);

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

        // 5. Dispara a pintura e o ranking após um pequeno delay
        setTimeout(async () => {
            pintarBordasDeCobertura(window.totaisPorMercado);
            await atualizarRankingEPilulasOtimizado();
            calcularTotalReal();
        }, 300);

    } catch (err) {
        console.error("Erro ao carregar lista:", err);
    }
}
/**
 * Busca em lote o melhor preço histórico de cada item (pílula individual).
 * Não depende mais de elementos de ranking (mercados-soma / totalizador-estimado).
 */
// Variável global para armazenar os preços que você digitar no mercado hoje
window.precosDigitadosNoMercado = {};

async function atualizarRankingEPilulasOtimizado() {
    try {
        const response = await fetch('/api/CompararPrecos');
        const data = await response.json();

        window.dadosOriginaisDicionario = data; // Guardamos para o cálculo live

        // 1. Renderiza as Caixas de Digitação (Inputs) fixas para cada item
        if (data.precosIndividuais && data.precosPorLojaCompleto) {
            Object.keys(data.precosIndividuais).forEach(nomeItem => {
                const idFormatado = nomeItem.replace(/\s+/g, '-');
                const el = document.getElementById(`preco-lista-${idFormatado}`);
                if (el) {
                    const info = data.precosIndividuais[nomeItem];
                    const p = data.precosPorLojaCompleto[nomeItem] || {};
                    const chaves = Object.keys(p);

                    // Busca os preços do banco (histórico) adicionando o Sam's Club
                    const precoCRF = p[chaves.find(k => k.toUpperCase().includes("CARREFOUR"))] || null;
                    const precoASA = p[chaves.find(k => k.toUpperCase().includes("ASSAI") || k.toUpperCase().includes("ASSAÍ"))] || null;
                    const precoATA = p[chaves.find(k => k.toUpperCase().includes("ATACADAO"))] || null;
                    const precoSAM = p[chaves.find(k => k.toUpperCase().includes("SAMS") || k.toUpperCase().includes("SAM'S"))] || null;

                    el.innerHTML = `
                        <div class="flex gap-1 mt-2 w-full overflow-x-auto pb-1 no-scrollbar scroll-smooth">
                            ${renderInputMercado('CRF', precoCRF, 'bg-green-50 text-green-700 border-green-200', nomeItem, 'CARREFOUR')}
                            ${renderInputMercado('ASA', precoASA, 'bg-yellow-50 text-yellow-700 border-yellow-200', nomeItem, 'ASSAI')}
                            ${renderInputMercado('ATA', precoATA, 'bg-cyan-50 text-cyan-700 border-cyan-200', nomeItem, 'ATACADAO')}
                            ${renderInputMercado('SAM', precoSAM, 'bg-indigo-50 text-indigo-700 border-indigo-200', nomeItem, 'SAMS CLUB')}
                        </div>
                        
                        ${info ? `
                        <div class="mt-1 text-[9px] bg-emerald-50 text-emerald-700 p-1 px-2 rounded-lg border border-emerald-200 flex justify-between items-center shadow-sm">
                            <span>💡 Recorde: ${info.loja}</span>
                            <span class="font-black text-emerald-800">R$ ${info.valor.toFixed(2)}</span>
                        </div>` : ''}
                        
                        <p class="text-[7px] text-gray-400 mt-1 italic text-center">Digite o preço na gôndola para comparar</p>
                    `;
                }
            });
        }

        recalcularRankingLive(data.ranking); // Desenha o ranking inicial
    } catch (e) {
        console.error("Erro ao processar inputs de comparação:", e);
    }
}

// Função que cria a caixa de digitação
function renderInputMercado(label, valorHistorico, cores, nomeItem, rede) {
    const valorAtual = (window.precosDigitadosNoMercado[nomeItem] && window.precosDigitadosNoMercado[nomeItem][rede]) 
                        || valorHistorico || '';
    
    return `
        <div class="min-w-[75px] flex-1 flex flex-col items-center p-1 rounded-md border ${cores} shadow-sm focus-within:ring-2 focus-within:ring-blue-400 transition-all">
            <span class="text-[7px] font-black uppercase opacity-70">${label}</span>
            <div class="flex items-center w-full justify-center">
                <span class="text-[8px] mr-0.5">R$</span>
                <input type="number" step="0.01" value="${valorAtual}" placeholder="---"
                    class="w-full max-w-[45px] bg-transparent text-[10px] font-bold outline-none text-center"
                    oninput="registrarPrecoLive('${nomeItem}', '${rede}', this.value)">
            </div>
        </div>`;
}

// 1. Busca os dados salvos no telemóvel (ou cria vazio se for a primeira vez)
window.precosDigitadosNoMercado = JSON.parse(localStorage.getItem('precosLive')) || {};

// 2. Atualizamos a função que regista o preço para gravar sempre no LocalStorage
function registrarPrecoLive(nome, rede, valor) {
    if (!window.precosDigitadosNoMercado[nome]) window.precosDigitadosNoMercado[nome] = {};
    window.precosDigitadosNoMercado[nome][rede] = parseFloat(valor) || null;

    // Salva no armazenamento do navegador (sobrevive a refresh e falta de internet)
    localStorage.setItem('precosLive', JSON.stringify(window.precosDigitadosNoMercado));

    // Atualiza o ecrã
    recalcularRankingLive(window.dadosOriginaisDicionario.ranking);
}

function recalcularRankingLive(rankingBase) {
    const containerRanking = document.getElementById('totalizador-estimado');
    if (!containerRanking) return;

    // Criamos uma cópia do ranking para recalcular com os preços digitados
    let novoRanking = rankingBase.map(loja => {
        let totalLive = 0;
        let encontrados = 0;

        // Percorremos os itens que você digitou ou que já estão no banco
        Object.keys(window.precosDigitadosNoMercado).forEach(nomeItem => {
            const precosDoItem = window.precosDigitadosNoMercado[nomeItem];
            const redeChave = Object.keys(precosDoItem).find(k => loja.nome.toUpperCase().includes(k));

            if (redeChave && precosDoItem[redeChave]) {
                totalLive += precosDoItem[redeChave];
                encontrados++;
            }
        });

        // Se você não digitou nada para esta loja, mantém o total do banco
        if (totalLive === 0) return loja;

        return { ...loja, total: totalLive, encontrados: encontrados, isLive: true };
    });

    // Ordena pelo mais barato
    novoRanking.sort((a, b) => a.total - b.total);

    // Desenha os cards no topo (Sticky)
    let html = `<p class="text-[9px] font-black text-blue-500 uppercase tracking-widest mb-3 text-center">📊 Comparativo em Tempo Real</p>
                <div class="flex gap-2 overflow-x-auto pb-2 no-scrollbar">`;

    novoRanking.forEach(loja => {
        const corCard = loja.isLive ? 'border-blue-500 bg-blue-50/20' : 'border-gray-200 bg-white';
        html += `
            <div class="min-w-[130px] p-2 rounded-xl border-l-4 ${corCard} shadow-sm transition-all">
                <p class="text-[7px] font-black text-gray-400 uppercase truncate">${loja.nome}</p>
                <p class="text-sm font-black ${loja.isLive ? 'text-blue-600' : 'text-gray-700'}">R$ ${loja.total.toFixed(2)}</p>
                <p class="text-[7px] font-bold text-gray-500">${loja.isLive ? 'Digitado Agora' : 'Dados do Banco'}</p>
            </div>`;
    });

    html += `</div>`;
    containerRanking.innerHTML = html;
    containerRanking.classList.remove('hidden');
}

/**
 * Função auxiliar para exibir "Sem histórico" nos itens que ainda não têm preço.
 * (opcional, melhora a experiência)
 */
function exibirSemHistorico() {
    // Percorre todos os cards da lista que não receberam pílula
    const cards = document.querySelectorAll('#lista-ativa > div');
    cards.forEach(card => {
        const precoDiv = card.querySelector('[id^="preco-lista-"]');
        if (precoDiv && precoDiv.innerHTML.trim() === '') {
            precoDiv.innerHTML = `
                <div class="mt-1 text-[9px] bg-gray-100 text-gray-500 p-1 px-2 rounded-lg">
                    📭 Sem histórico de preços
                </div>`;
        }
    });
}
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
 * Salva a quantidade informada no banco (debounced) e recarrega a lista.
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
            // ❌ ANTIGO: carregarLista();  -> recria tudo, trava com 100 itens
            // ✅ NOVO: Só atualiza ranking e pílulas (leve e rápido)
            await atualizarRankingEPilulasOtimizado();
            calcularTotalReal(); // Recalcula o total exibido
        } catch (e) { console.error(e); }
    }, 1000);
}

// ================== GRÁFICO DE HISTÓRICO DO PRODUTO ==================
/**
 * Abre o modal do gráfico com botões de filtro de período.
 */
async function abrirGrafico(nome) {
    const nomeSeguro = nome.replace(/'/g, "\\'");
    let canvasHtml = `
    <div id="modal-grafico" class="fixed inset-0 bg-black/80 z-[60] p-4 flex flex-col justify-center">
        <div class="bg-white rounded-3xl p-6 w-full max-w-lg shadow-2xl animate-fade-in">
            <div class="flex justify-between items-start mb-4">
                <div>
                    <p class="text-[10px] font-black text-blue-400 uppercase tracking-[0.2em]">Histórico de Preços</p>
                    <h3 class="text-sm font-black text-gray-800 uppercase leading-tight">${nome}</h3>
                </div>
                <button onclick="document.getElementById('modal-grafico').remove()" class="bg-red-50 text-red-500 rounded-full w-8 h-8 flex items-center justify-center font-bold shadow-sm active:scale-90">✕</button>
            </div>
            
            <div class="flex gap-2 mb-6 justify-center" id="filtros-grafico">
                <button onclick="filtrarPeriodoGrafico('${nomeSeguro}', 7, this)" class="btn-filtro flex-1 py-2 bg-gray-100 text-[9px] font-black rounded-xl hover:bg-blue-50 transition-all">7D</button>
                <button onclick="filtrarPeriodoGrafico('${nomeSeguro}', 30, this)" class="btn-filtro flex-1 py-2 bg-gray-100 text-[9px] font-black rounded-xl hover:bg-blue-50 transition-all">30D</button>
                <button onclick="filtrarPeriodoGrafico('${nomeSeguro}', 90, this)" class="btn-filtro flex-1 py-2 bg-gray-100 text-[9px] font-black rounded-xl hover:bg-blue-50 transition-all">90D</button>
                <button onclick="filtrarPeriodoGrafico('${nomeSeguro}', 0, this)" class="btn-filtro flex-1 py-2 bg-blue-600 text-white text-[9px] font-black rounded-xl shadow-md">TUDO</button>
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
                            // CORREÇÃO MERCADO: Exibe o nome da loja no balão informativo
                            afterLabel: (context) => `Loja: ${dados[context.dataIndex].mercado}`
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: false,
                        grid: { color: '#f3f4f6' },
                        ticks: { font: { size: 9 } }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { font: { size: 8 } }
                    }
                }
            }
        };

        if (chartInstance) {
            chartInstance.data = config.data;
            chartInstance.options = config.options; // Garante atualização do tooltip
            chartInstance.update();
        } else {
            new Chart(ctx, config);
        }
    } catch (e) {
        console.error("Erro ao carregar gráfico filtrado:", e);
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
        carregarLista();
    } catch (e) { console.error(e); }
}

// ================== NOTA FISCAL ==================
async function processarUrlManual() {
    const urlInput = document.getElementById('url-input');
    const url = urlInput.value.trim();
    if (!url) return;
    const statusDiv = document.getElementById('status');
    statusDiv.classList.remove('hidden');
    statusDiv.innerText = "📡 Analisando CNPJ da nota...";
    try {
        // Consulta apenas para saber se o estabelecimento já é conhecido
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
    } catch (err) {
        statusDiv.innerText = "❌ Erro ao processar nota.";
        console.error(err);
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
            <p class="text-[11px] font-bold ${temNomeAmigavel ? 'text-gray-800' : 'text-orange-500'} uppercase leading-tight">
                ${temNomeAmigavel ? produtoVinculado.nome_comum : item.descricao}
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

    // Se cancelar o prompt, para aqui
    if (novoNome === null) return;

    const nomeFinal = novoNome.trim().toUpperCase(); // Limpeza extra
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
            fotoUrl: foto // Enviamos o que vier, a API decide se usa
        })
    }).then(() => {
        processarUrlManual();
        renderizarDicionario();
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
    } catch (e) { console.error("Erro no alerta de preço", e); }
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
                .map(nome => `<option value="${nome.toUpperCase()}">`).join('');
        }
    } catch (e) { }
}

// ================== EXCLUSÃO E FINALIZAÇÃO ==================
async function deletarItem(nome) {
    if (!confirm(`Remover ${nome} da lista?`)) return;
    try {
        await fetch(`/api/GerenciarLista?nome=${encodeURIComponent(nome)}`, { method: 'DELETE' });

        // Remove o valor digitado da memória e atualiza o armazenamento
        if (window.precosDigitadosNoMercado && window.precosDigitadosNoMercado[nome]) {
            delete window.precosDigitadosNoMercado[nome];
            localStorage.setItem('precosLive', JSON.stringify(window.precosDigitadosNoMercado));
        }

        carregarLista(); // O ranking vai recalcular automaticamente sem este item
    } catch (e) {
        console.error("Erro ao deletar item:", e);
    }
}

async function finalizarCompra() {
    if (!confirm("Deseja limpar toda a lista?")) return;
    try {
        await fetch('/api/GerenciarLista', { method: 'DELETE' });

        // Zera toda a memória de digitação e limpa completamente o armazenamento do telemóvel
        window.precosDigitadosNoMercado = {};
        localStorage.removeItem('precosLive');

        // Zera o totalizador visual no ecrã imediatamente
        const display = document.getElementById('total-real-dinamico');
        if (display) display.innerText = "R$ 0,00";

        // Esconde o painel do ranking
        const ranking = document.getElementById('totalizador-estimado');
        if (ranking) ranking.classList.add('hidden');

        carregarLista(); // Recarrega a lista agora vazia
    } catch (e) {
        console.error("Erro ao finalizar compra:", e);
    }
}

async function renderizarRankingTopCompras() {
    const container = document.getElementById('lista-gastos-detalhada'); // Reutilizando o container de detalhes
    if (!container) return;

    // Mostra um carregando para dar feedback visual
    container.innerHTML = '<p class="text-center text-gray-400 text-[10px] animate-pulse py-8">CALCULANDO SEU CONSUMO EM OSASCO...</p>';

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
    <div onclick="abrirGrafico('${item._id}')" 
         class="bg-white p-3 rounded-2xl border border-gray-100 shadow-sm flex items-center gap-4 cursor-pointer hover:bg-blue-50 transition-colors">
        <span class="text-lg font-black text-blue-200">#${index + 1}</span>
        <img src="${item.foto || 'https://via.placeholder.com/50'}" class="w-10 h-10 rounded-lg object-cover bg-gray-50">
        <div class="flex-1">
            <p class="text-[10px] font-black text-gray-700 uppercase">${item._id}</p>
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
    } catch (e) { console.error("Erro no ranking de volume:", e); }
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
                labels: dados.map(d => d._id.split(' ')[0] + '...'), // Abrevia o nome
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
    } catch (e) { console.error(e); }
}

(function debugCores() {
    console.log("--- INICIANDO DEBUG DE CORES ---");
    const listaItens = document.querySelectorAll('.nome-item');

    listaItens.forEach(el => {
        const nomeOriginal = el.innerText.trim();
        const nomeBusca = nomeOriginal.toUpperCase();
        const dados = window.totaisPorMercado[nomeBusca];

        console.group(`Produto: ${nomeOriginal}`);
        if (!dados) {
            console.error("❌ ERRO: Produto não encontrado em window.totaisPorMercado. Verifique se o nome no Dicionário é IDENTICO ao da Lista.");
            console.log("Nomes disponíveis no sistema:", Object.keys(window.totaisPorMercado));
        } else {
            const chaves = Object.keys(dados);
            const temCRF = chaves.some(k => k.includes("CARREFOUR") && dados[k] !== null);
            const temASA = chaves.some(k => (k.includes("ASSAI") || k.includes("ASSAÍ")) && dados[k] !== null);
            const temATA = chaves.some(k => k.includes("ATACADAO") && dados[k] !== null);

            console.log("Dados Brutos da API:", dados);
            console.log(`Tem Carrefour? ${temCRF ? '✅' : '❌'}`);
            console.log(`Tem Assaí? ${temASA ? '✅' : '❌'}`);
            console.log(`Tem Atacadão? ${temATA ? '✅' : '❌'}`);

            const total = [temCRF, temASA, temATA].filter(v => v).length;
            console.log(`Total de lojas detectadas: ${total}/3`);

            if (total < 3) {
                console.warn("⚠️ MOTIVO DO LARANJA: O sistema não encontrou preço para uma das 3 redes principais acima.");
            } else {
                console.info("✨ DEVERIA SER TRANSPARENTE: Se está laranja e o total é 3, há um erro de CSS ou o elemento não recebeu a classe.");
            }
        }
        console.groupEnd();
    });
    console.log("--- FIM DO DEBUG ---");
})();

function pintarBordasDeCobertura(dadosComparativos) {
    const cards = document.querySelectorAll('[data-produto]');

    cards.forEach(card => {
        const nome = card.getAttribute('data-produto');
        const p = dadosComparativos[nome] || {};
        const chaves = Object.keys(p);

        // Checagem flexível para as redes
        const temCRF = chaves.some(k => k.toUpperCase().includes("CARREFOUR") && p[k] !== null);
        const temASA = chaves.some(k => (k.toUpperCase().includes("ASSAI") || k.toUpperCase().includes("ASSAÍ")) && p[k] !== null);
        const temATA = chaves.some(k => k.toUpperCase().includes("ATACADAO") && p[k] !== null);

        const total = [temCRF, temASA, temATA].filter(v => v).length;

        // Reset de classes de borda
        card.classList.remove('border-orange-400', 'border-red-500', 'border-transparent');

        if (total >= 3) {
            card.classList.add('border-transparent'); // Tudo ok!
        } else if (total === 0) {
            card.classList.add('border-red-500'); // Sem dados
        } else {
            card.classList.add('border-yellow-400'); // Dados parciais
        }
    });
}

// ================== INICIALIZAÇÃO ==================
carregarLista();
carregarSugestoes();