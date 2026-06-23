// ================== ESTADO GLOBAL ==================
let totaisPorMercado = {};           // Dados de preços por loja (vindos da API)
let itensSelecionados = new Set();    // IDs dos produtos selecionados no dicionário
let meuGraficoRelatorio = null;       // Instância do gráfico de gastos
let timeoutPreco, timeoutQtd;         // Debouncers para salvar preço e quantidade
let categoriaSelecionadaFiltro = "TUDO";

// Armazena os preços digitados pelo usuário em tempo real (persistidos no localStorage)
window.precosDigitadosNoMercado = JSON.parse(localStorage.getItem('precosLive')) || {};

// ================== FUNÇÕES UTILITÁRIAS ==================

/**
 * Escapa caracteres especiais para uso em atributos HTML.
 * @param {string} str - String a ser escapatada.
 * @returns {string}
 */
function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

/**
 * Retorna uma cor hexadecimal para o mercado (usado nos gráficos e cards).
 * @param {string} nomeMercado - Nome do mercado.
 * @returns {string}
 */
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

/**
 * Exibe um modal com a imagem ampliada do produto.
 * @param {string} url - URL da imagem.
 * @param {string} nome - Nome do produto.
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
                <p class="text-white text-center mt-4 font-bold uppercase tracking-widest text-[10px]">${nome}</p>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

// ================== ABAS ==================

/**
 * Alterna entre as abas: Lista, Dicionário, Relatórios.
 * @param {string} aba - 'lista', 'dicionario' ou 'relatorios'
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

// ================== RELATÓRIOS ==================

/**
 * Carrega o gráfico de gastos por categoria (pizza) e popula o filtro de lojas.
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
    } catch (e) { console.error("Erro ao carregar gráfico:", e); }
}

/**
 * Popula o seletor de lojas com os valores disponíveis no banco.
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
 * Exibe os itens detalhados de uma categoria (ao clicar no gráfico).
 * @param {object} categoria - Objeto contendo _id, totalGasto e detalhes.
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
                    <span class="text-[9px] text-gray-400 font-medium">${item.qtd}x de R$ ${unitario.toFixed(2)}</span>
                </div>
                <span class="text-blue-700 font-black whitespace-nowrap">R$ ${item.valor.toFixed(2)}</span>
            </div>`;
    });
    html += `</div></div>`;
    container.innerHTML = html;
    container.scrollIntoView({ behavior: 'smooth' });
}

// ================== LISTA DE COMPRAS ==================

/**
 * Carrega a lista ativa do backend, renderiza os cards e aciona a pintura de bordas e ranking.
 */
async function carregarLista() {
    totaisPorMercado = {};
    const listaDiv = document.getElementById('lista-ativa');
    listaDiv.innerHTML = '<p class="text-gray-400 text-xs text-center animate-pulse">Sincronizando...</p>';

    try {
        // Busca concorrentemente os dados da lista, vínculos do dicionário e comparativo base
        const [respLista, respDict, respPrecos] = await Promise.all([
            fetch('/api/GerenciarLista'),
            fetch('/api/VincularProdutos'),
            fetch('/api/CompararPrecos')
        ]);

        const itens = await respLista.json();
        const dicionario = await respDict.json();
        const dataPrecos = await respPrecos.json();

        // Armazena em cache global a estrutura de preços por loja vinda do histórico do banco
        window.totaisPorMercado = dataPrecos.precosPorLojaCompleto || {};

        // Guarda o dicionário e ranking base na janela global para uso de outras funções (como o recalcularRankingLive)
        window.dadosOriginaisDicionario = dataPrecos;

        // Se a lista estiver vazia, encerra limpando a tela e escondendo o ranking superior
        if (itens.length === 0) {
            listaDiv.innerHTML = '<p class="text-gray-500 italic text-center py-4">Tudo pronto! 🎉</p>';
            document.getElementById('totalizador-estimado').classList.add('hidden');
            return;
        }

        // Mapeia e injeta a categoria correta em cada item consultando o dicionário de vínculos
        const itensOrdenados = itens.map(item => {
            const info = dicionario.find(p => p.nome_comum === item.item_nome) || {};
            return { ...item, categoria: (info.categoria || "OUTROS").toUpperCase() };
        });

        // Ordena alfabeticamente pelas categorias para agrupar os itens por corredor
        itensOrdenados.sort((a, b) => a.categoria.localeCompare(b.categoria));

        // [NOVO] Renderiza dinamicamente as pílulas de categorias com base nos itens que estão na lista ativa
        renderizarFiltrosCategorias(itensOrdenados);

        listaDiv.innerHTML = '';
        let categoriaAtual = "";

        // Renderiza cada item agrupando-os visualmente por blocos de corredores
        itensOrdenados.forEach(item => {
            const infoDict = dicionario.find(p => p.nome_comum === item.item_nome) || {};

            // Tratamentos de strings seguras para evitar quebras em atributos HTML e ID do DOM
            const idFormatado = item.item_nome.replace(/[^a-zA-Z0-9]/g, '_');
            const nomeSeguro = escapeHTML(item.item_nome).replace(/'/g, "\\'");
            const nomeBusca = item.item_nome.trim().toUpperCase();

            const isComprado = item.comprado === true;
            const qtd = item.quantidade || 1;
            const precoReal = item.preco_real || '';

            // Se mudou de categoria, cria uma nova divisória de cabeçalho de corredor
            if (item.categoria !== categoriaAtual) {
                categoriaAtual = item.categoria;
                const separador = document.createElement('div');

                // Adicionadas classes e atributos essenciais para a inteligência da função 'filtrarPorCorredor'
                separador.className = "header-corredor text-[10px] font-black text-blue-500 mt-4 mb-2 uppercase tracking-widest border-l-4 border-blue-50 border-blue-500 pl-2 bg-blue-50/50 py-1 rounded-r";
                separador.setAttribute('data-categoria', categoriaAtual);
                separador.innerHTML = `📍 CORREDOR: ${categoriaAtual}`;
                listaDiv.appendChild(separador);
            }

            // Instancia o container principal do Card do Produto
            const itemElement = document.createElement('div');

            // Adicionados atributos estruturais 'card-produto-lista' e 'data-categoria-produto' para o filtro funcionar
            itemElement.className = `card-produto-lista bg-white p-2 rounded-xl border border-blue-50 border-l-4 border-yellow-400 shadow-sm mb-2 flex items-center gap-3 ${isComprado ? 'item-comprado opacity-60' : ''}`;
            itemElement.setAttribute('data-produto', nomeBusca);
            itemElement.setAttribute('data-categoria-produto', item.categoria);

            // Injeta o HTML em linha única compactada para smartphones (Sua recomendação)
            itemElement.innerHTML = `
                <div class="flex flex-col w-full gap-2">
                    <div class="flex items-center gap-2 w-full justify-between">
                        <div class="flex items-center gap-2 min-w-0 flex-1">
                            <div class="w-10 h-10 shrink-0 overflow-hidden rounded-lg border border-gray-100 bg-gray-50 cursor-pointer" 
                                 onclick="ampliarImagem('${infoDict.foto_url || 'https://via.placeholder.com/50'}', '${nomeSeguro}')">
                                <img src="${infoDict.foto_url || 'https://via.placeholder.com/50'}" class="w-full h-full object-cover">
                            </div>
                            <span class="nome-item font-bold text-gray-700 uppercase text-[11px] leading-tight truncate flex-1" 
                                  title="${item.item_nome}" onclick="abrirGrafico('${nomeSeguro}')">
                                ${item.item_nome}
                            </span>
                        </div>

                        <div class="relative flex items-center gap-1 bg-blue-50/40 p-1 rounded-lg shrink-0">
                            <div id="alerta-${idFormatado}" class="absolute -top-5 right-0 z-10 pointer-events-none"></div>
                            
                            <input type="number" min="1" value="${qtd}" 
                                class="input-qtd-real w-7 p-0 text-[10px] font-black text-blue-700 bg-transparent border-none text-center outline-none"
                                oninput="calcularTotalReal(); agendarSalvarQtd('${nomeSeguro}', this.value)">
                            
                            <span class="text-[8px] text-blue-400">x</span>
                            
                            <input type="number" step="0.01" value="${precoReal}" placeholder="0,00"
                                oninput="calcularTotalReal(); salvarPrecoNoBanco('${nomeSeguro}', this.value); verificarAlertaPreco('${nomeSeguro}', this.value, document.getElementById('alerta-${idFormatado}'))" 
                                class="input-preco-real w-12 p-1 text-[10px] border border-blue-200 rounded text-center outline-none bg-white focus:ring-1 focus:ring-blue-500">
                            
                            <button onclick="alternarStatus('${nomeSeguro}', ${!isComprado})" class="text-sm ml-0.5 active:scale-90 transition-transform">
                                ${isComprado ? '🔄' : '✅'}
                            </button>
                            <button onclick="deletarItem('${nomeSeguro}')" class="text-sm ml-0.5 text-gray-400 hover:text-red-500 rounded p-0.5">🗑️</button>
                        </div>
                    </div>

                    <div id="preco-lista-${idFormatado}" class="w-full"></div>
                </div>`;

            listaDiv.appendChild(itemElement);

            // Caso o item já tenha um preço real digitado anteriormente, dispara a verificação de alerta de inflação
            if (precoReal) {
                verificarAlertaPreco(item.item_nome, precoReal, document.getElementById(`alerta-${idFormatado}`));
            }
        });

        // Aguarda um curto período para garantir a fixação dos elementos no DOM antes de rodar os scripts visuais pós-carga
        setTimeout(() => {
            pintarBordasDeCobertura(window.totaisPorMercado); // Colore bordas esquerdas conforme menor preço histórico
            atualizarPrecosEPilulas();                        // Popula os carrosséis inferiores e o ranking superior inteligente
            calcularTotalReal();                              // Calcula e fixa o total planejado/carrinho no header

            // [NOVO] Garante que, se a página atualizar, o corredor selecionado anteriormente permaneça ativo e filtrado
            if (typeof categoriaSelecionadaFiltro !== 'undefined' && categoriaSelecionadaFiltro !== "TUDO") {
                filtrarPorCorredor(categoriaSelecionadaFiltro);
            }
        }, 300);

    } catch (err) {
        console.error("Erro fatal ao processar e renderizar a lista de compras:", err);
    }
}
/**
 * Atualiza os 4 boxes de digitação de preços (Carrefour, Assaí, Atacadão, Sams)
 * e também o ranking no elemento 'totalizador-estimado'.
 */
/**
 * Atualiza os 4 boxes de preço injetando os valores históricos do banco caso não haja digitação.
 */
async function atualizarPrecosEPilulas() {
    try {
        const respPrecos = await fetch('/api/CompararPrecos');
        const data = await respPrecos.json();
        window.dadosOriginaisDicionario = data;

        // Pega todos os cards visíveis ou invisíveis da lista ativa
        const cards = document.querySelectorAll('#lista-ativa .card-produto-lista');

        cards.forEach(card => {
            const nomeProduto = card.getAttribute('data-produto');
            if (!nomeProduto) return;

            // 🔥 CORREÇÃO DO ID: Usa exatamente o mesmo padrão de Regex da carregarLista()
            // Buscando o nome original a partir do cache ou tratando a string de forma idêntica
            const dadosLista = window.dadosOriginaisDicionario?.precosPorLojaCompleto || {};

            // Encontra a chave original correspondente no banco (com acentos/caixa alta)
            const nomeReal = Object.keys(dadosLista).find(k => k.trim().toUpperCase() === nomeProduto) || nomeProduto;
            const idFormatado = nomeReal.replace(/[^a-zA-Z0-9]/g, '_');

            const containerPreco = document.getElementById(`preco-lista-${idFormatado}`);
            if (!containerPreco) return;

            // Busca preços históricos do banco
            const precosPorLoja = dadosLista[nomeReal] || {};
            const precoCRF = precosPorLoja[Object.keys(precosPorLoja).find(k => k.toUpperCase().includes("CARREFOUR"))] || null;
            const precoASA = precosPorLoja[Object.keys(precosPorLoja).find(k => k.toUpperCase().includes("ASSAI") || k.toUpperCase().includes("ASSAÍ"))] || null;
            const precoATA = precosPorLoja[Object.keys(precosPorLoja).find(k => k.toUpperCase().includes("ATACADAO"))] || null;
            const precoSAM = precosPorLoja[Object.keys(precosPorLoja).find(k => k.toUpperCase().includes("SAMS") || k.toUpperCase().includes("SAM'S") || k.toUpperCase().includes("CLUB"))] || null;

            // Busca os digitados da sessão atual (MongoDB Temp)
            const digitados = window.precosDigitadosNoMercado?.[nomeReal.trim().toUpperCase()] || {};

            // Injeta o HTML renderizando os inputs com indicador inteligente
            containerPreco.innerHTML = `
                <div class="flex gap-1 mt-2 w-full overflow-x-auto pb-1 no-scrollbar scroll-smooth">
                    ${renderInputMercado('Carrefour', digitados['CARREFOUR'], precoCRF, 'bg-green-50 text-green-700 border-green-200', nomeReal, 'CARREFOUR')}
                    ${renderInputMercado('Assaí', digitados['ASSAI'], precoASA, 'bg-yellow-50 text-yellow-700 border-yellow-200', nomeReal, 'ASSAI')}
                    ${renderInputMercado('Atacadão', digitados['ATACADAO'], precoATA, 'bg-cyan-50 text-cyan-700 border-cyan-200', nomeReal, 'ATACADAO')}
                    ${renderInputMercado('Sams Club', digitados['SAMS CLUB'], precoSAM, 'bg-indigo-50 text-indigo-700 border-indigo-200', nomeReal, 'SAMS CLUB')}
                </div>
                <div class="mt-1 text-[9px] bg-emerald-50 text-emerald-700 p-1 px-2 rounded-lg border border-emerald-200 flex justify-between items-center shadow-sm">
                    <span>💡 Menor Preço Histórico: ${data.precosIndividuais?.[nomeReal]?.loja || 'N/A'}</span>
                    <span class="font-black">R$ ${data.precosIndividuais?.[nomeReal]?.valor?.toFixed(2) || '--'}</span>
                </div>`;
        });

        recalcularRankingLive(data.ranking || []);
    } catch (e) {
        console.error("Erro ao sincronizar pílulas de mercados:", e);
    }
}
/**
 * Componente do Input com inteligência visual (Diferencia estimativa de preço real).
 */
function renderInputMercado(label, valorDigitado, valorBanco, classes, nomeProduto, rede) {
    // Se o usuário já digitou algo, prioriza. Caso contrário, assume o valor estável do banco
    const temDigitado = valorDigitado !== undefined && valorDigitado !== null && valorDigitado !== '';
    const valorExibido = temDigitado ? valorDigitado : (valorBanco || '');

    // Configura o indicador visual (✍️ para manual, 🏦 para histórico do MongoDB)
    const indicador = temDigitado ? '✍️' : (valorBanco ? '🏦' : '---');
    const estiloTexto = temDigitado ? 'font-black text-gray-900' : 'font-medium text-gray-400/90 italic';

    return `
        <div class="flex-1 min-w-[78px] p-1 rounded-lg border ${classes} text-center shadow-sm relative">
            <div class="flex justify-between items-center px-0.5 mb-0.5">
                <span class="text-[7px] uppercase font-black tracking-wider opacity-75">${label}</span>
                <span class="text-[6px] opacity-75">${indicador}</span>
            </div>
            <input type="number" step="0.01" value="${valorExibido}" placeholder="---"
                class="input-preco-mercado w-full bg-transparent border-none text-center outline-none text-[10px] p-0 m-0 ${estiloTexto}"
                oninput="registrarPrecoLive('${nomeProduto.replace(/'/g, "\\'")}', '${rede}', this.value)">
        </div>
    `;
}

/**
 * Registra o preço digitado para um produto e rede, salva no localStorage e atualiza o ranking.
 * @param {string} nome - Nome do produto
 * @param {string} rede - Rede (CARREFOUR, ASSAI, ...)
 * @param {number} valor - Preço digitado
 */
async function registrarPrecoLive(nome, rede, valor) {
    const numValor = parseFloat(valor);

    // Agora aceitamos o 0 de forma intencional
    const valorValido = !isNaN(numValor) && numValor >= 0;

    if (!window.precosDigitadosNoMercado[nome]) {
        window.precosDigitadosNoMercado[nome] = {};
    }

    // Se o usuário digitou 0 ou limpou o campo, definimos explicitamente como 0
    window.precosDigitadosNoMercado[nome][rede] = isNaN(numValor) ? null : numValor;

    // Recalcula o ranking imediatamente na tela
    recalcularRankingLive(window.dadosOriginaisDicionario?.ranking || []);

    // Persiste no Banco de Dados Temporário
    if (valorValido) {
        try {
            await fetch('/api/GerenciarPrecosTemp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item: nome.toUpperCase(), loja: rede.toUpperCase(), preco: numValor })
            });
        } catch (e) { console.error("Erro ao sincronizar preço temporário:", e); }
    }
}

/**
 * Recalcula e exibe o ranking das lojas com base nos preços digitados pelo usuário.
 * @param {Array} rankingBase - Ranking original vindo da API (opcional)
 */
/**
 * Recalcula o ranking somando Preços Digitados + Preços do Banco (onde não houver digitação).
 */
/**
 * Soma dinamicamente os valores reais digitados + estimativas históricas para atualizar o topo.
 */
function recalcularRankingLive(rankingBase) {
    const containerRanking = document.getElementById('totalizador-estimado');
    if (!containerRanking) return;

    // Redes que vamos comparar
    const lojas = ['CARREFOUR', 'ASSAI', 'ATACADAO', 'SAMS CLUB'];
    const totais = {};
    lojas.forEach(loja => { totais[loja] = 0; });

    // Percorremos todos os cards de produtos visíveis na tela
    const cards = document.querySelectorAll('#lista-ativa div[data-produto]');

    cards.forEach(card => {
        const nomeProduto = card.getAttribute('data-produto');
        const inputQtd = card.querySelector('.input-qtd-real');
        const qtd = parseFloat(inputQtd ? inputQtd.value : 1) || 1;

        lojas.forEach(loja => {
            // 1. Tenta pegar o preço que você digitou temporariamente nesta sessão
            // Dentro do laço lojas.forEach na função recalcularRankingLive:
            let precoParaSomar = window.precosDigitadosNoMercado[nomeProduto]?.[loja];

            // Se for exatamente 0, significa que o usuário anulou manualmente o valor histórico
            if (precoParaSomar === 0) {
                precoParaSomar = 0; // Mantém zero e não pega o do banco
            }
            // Se estiver vazio ou nulo (undefined), aí sim busca o histórico do banco
            else if (precoParaSomar === undefined || precoParaSomar === null) {
                const dadosBanco = window.dadosOriginaisDicionario?.precosPorLojaCompleto?.[nomeProduto];
                const chaveLojaBanco = Object.keys(dadosBanco || {}).find(k => k.toUpperCase().includes(loja));
                precoParaSomar = dadosBanco && chaveLojaBanco ? dadosBanco[chaveLojaBanco] : 0;
            }

            if (precoParaSomar > 0) {
                totais[loja] += precoParaSomar * qtd;
            }
        });
    });

    // Converte para formato de array e ordena do mais barato para o mais caro
    const rankingCalculado = Object.entries(totais)
        .filter(([_, total]) => total > 0)
        .map(([loja, total]) => ({ nome: loja, total }))
        .sort((a, b) => a.total - b.total);

    if (rankingCalculado.length === 0) {
        containerRanking.classList.add('hidden');
        return;
    }

    // Remove o hidden e renderiza o layout fixo no topo
    containerRanking.classList.remove('hidden');
    exibirRanking(rankingCalculado);
}
/**
 * Renderiza os cards do ranking dentro do elemento 'totalizador-estimado'.
 * @param {Array} ranking - Array de objetos { nome, total }
 */
function exibirRanking(ranking) {
    const containerRanking = document.getElementById('totalizador-estimado');
    if (!containerRanking) return;
    containerRanking.classList.remove('hidden');

    // Mudamos o texto para branco para contrastar com o fundo azul do header
    let html = `<p class="text-[9px] font-black text-blue-100 uppercase tracking-widest mb-2 text-center">📊 Melhor Mercado Atual</p>
                <div class="flex gap-2 overflow-x-auto pb-1 no-scrollbar">`;

    ranking.forEach((loja, idx) => {
        const isVencedor = idx === 0;
        // Cards levemente translúcidos ou sólidos dependendo da vitória
        html += `
            <div class="min-w-[110px] p-2 rounded-xl border-l-4 ${isVencedor ? 'border-green-400 bg-white' : 'border-blue-400 bg-blue-500/50'} shadow-md transition-all">
                <p class="text-[7px] font-black ${isVencedor ? 'text-gray-500' : 'text-blue-100'} uppercase truncate">${loja.nome}</p>
                <p class="text-sm font-black ${isVencedor ? 'text-gray-800' : 'text-white'}">R$ ${loja.total.toFixed(2)}</p>
            </div>`;
    });

    html += `</div>`;
    containerRanking.innerHTML = html;
}

/**
 * Pinta a borda esquerda de cada card conforme a cobertura de preços (0, 1-2 ou 3+ lojas).
 * @param {object} dadosComparativos - Objeto com preços por loja para cada produto.
 */
function pintarBordasDeCobertura(dadosComparativos) {
    const cards = document.querySelectorAll('[data-produto]');
    cards.forEach(card => {
        const nome = card.getAttribute('data-produto');
        const p = dadosComparativos[nome] || {};
        const chaves = Object.keys(p);

        const temCRF = chaves.some(k => k.toUpperCase().includes("CARREFOUR") && p[k] !== null);
        const temASA = chaves.some(k => (k.toUpperCase().includes("ASSAI") || k.toUpperCase().includes("ASSAÍ")) && p[k] !== null);
        const temATA = chaves.some(k => k.toUpperCase().includes("ATACADAO") && p[k] !== null);
        const total = [temCRF, temASA, temATA].filter(v => v).length;

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

// ================== FUNÇÕES DE PERSISTÊNCIA ==================

/**
 * Calcula o total real da lista (soma preço * quantidade de cada item) e atualiza o display.
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
            total += preco * qtd;
        }
    });
    const display = document.getElementById('total-real-dinamico');
    if (display) display.innerText = `R$ ${total.toFixed(2).replace('.', ',')}`;
}

/**
 * Salva o preço real no backend (debounced).
 * @param {string} nome - Nome do produto
 * @param {number} valor - Preço digitado
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
 * Salva a quantidade no backend e recarrega os preços (debounced).
 * @param {string} nome - Nome do produto
 * @param {number} qtd - Quantidade
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
            // Atualiza apenas os preços e ranking, sem recarregar a lista inteira
            await atualizarPrecosEPilulas();
            calcularTotalReal();
        } catch (e) { console.error(e); }
    }, 1000);
}

// ================== GRÁFICO DE HISTÓRICO DO PRODUTO ==================

/**
 * Abre um modal com o gráfico de evolução de preços do produto.
 * @param {string} nome - Nome do produto
 */
async function abrirGrafico(nome) {
    // Remove modal anterior se existir
    const modalExistente = document.getElementById('modal-grafico');
    if (modalExistente) modalExistente.remove();

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
    await filtrarPeriodoGrafico(nome, 0);
}

/**
 * Filtra o gráfico por período (dias) e renderiza os dados.
 * @param {string} nome - Nome do produto
 * @param {number} dias - Número de dias (0 = todos)
 * @param {HTMLElement} btn - Botão clicado (para estilização)
 */
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
    }
}

// ================== DICIONÁRIO ==================

/**
 * Renderiza a lista de produtos do dicionário, agrupados por categoria.
 */
// 🔥 Se você for usar módulos de cara, adicione este import no topo do script.js:
// import { buscarVinculosDicionariop } from './api.js';

async function renderizarDicionario() {
    const container = document.getElementById('lista-dicionario');
    if (!container) return;

    container.innerHTML = '<p class="text-center text-gray-400 p-4">Carregando catálogo...</p>';
    itensSelecionados.clear();

    const btnMultiplos = document.getElementById('btn-adicionar-multiplos');
    if (btnMultiplos) btnMultiplos.classList.add('hidden');

    const selectAllCheck = document.getElementById('select-all-dict');
    if (selectAllCheck) selectAllCheck.checked = false;

    try {
        const produtos = typeof buscarVinculosDicionario === 'function'
            ? await buscarVinculosDicionario()
            : await fetch('/api/VincularProdutos').then(r => r.json());

        const categories = {};
        produtos.forEach(p => {
            const cat = (p.categoria || "OUTROS").toUpperCase();
            if (!categories[cat]) categories[cat] = [];
            categories[cat].push(p);
        });

        container.innerHTML = '';

        for (const [cat, itens] of Object.entries(categories)) {
            const div = document.createElement('div');
            div.className = "mb-4 block-categoria-dicionario";
            div.setAttribute('data-categoria-dict', cat);

            div.innerHTML = `<h3 class="text-[10px] font-black text-blue-500 mb-2 uppercase tracking-widest border-l-4 border-blue-500 pl-2">${cat}</h3>`;

            itens.forEach(prod => {
                const fotoUrl = prod.foto_url || 'https://via.placeholder.com/50';
                const nomeSeguro = escapeHTML(prod.nome_comum);
                
                // Lógica do Sininho
                const isMonitorado = prod.monitorar === true;
                const classeSino = isMonitorado 
                    ? 'bg-green-100 rounded-full shadow-sm border border-green-300 scale-110 p-1' 
                    : 'grayscale opacity-40 hover:opacity-80 bg-gray-50 rounded-full p-1';
                const iconeSino = isMonitorado ? '🔔' : '🔕';

                // Lógica da Corrente (Link SAMS)
                const temLinkSams = prod.url_sams && prod.url_sams.trim() !== '';
                const classeCorrente = temLinkSams
                    ? 'opacity-100 bg-blue-100 border border-blue-300 rounded-md'
                    : 'opacity-50 hover:opacity-100';

                div.innerHTML += `
                    <div class="item-dicionario-lista bg-white p-2 rounded-xl border border-gray-100 flex items-center mb-1 shadow-sm gap-3"
                         data-categoria-dict="${cat}">
                        <input type="checkbox" data-nome="${nomeSeguro}" onchange="toggleSelecao('${nomeSeguro}', this.checked)" class="w-4 h-4 rounded border-gray-300 text-blue-600">
                        <div class="w-10 h-10 shrink-0 overflow-hidden rounded-lg bg-gray-50 cursor-pointer" onclick="ampliarImagem('${fotoUrl}', '${nomeSeguro}')">
                            <img src="${fotoUrl}" class="w-full h-full object-cover">
                        </div>
                        
                        <div class="flex-1 flex items-center gap-2 min-w-0">
                            <p class="text-[10px] font-bold text-gray-800 uppercase truncate">${prod.nome_comum}</p>
                            
                            <div class="flex items-center gap-1 shrink-0">
                                <!-- Botão Gráfico -->
                                <button onclick="abrirGrafico('${nomeSeguro.replace(/'/g, "\\'")}')" 
                                        class="text-[11px] opacity-60 hover:opacity-100 active:scale-90 transition-all p-0.5" 
                                        title="Ver histórico de preços">
                                    📊
                                </button>
                                
                                <!-- Botão de Inserir Link do Site -->
                                <button onclick="inserirLinkLoja('${nomeSeguro.replace(/'/g, "\\'")}', 'SAMS')" 
                                        class="text-[11px] transition-all p-0.5 active:scale-90 ${classeCorrente}" 
                                        title="${temLinkSams ? 'Link do Sam\\'s Club já salvo! Clique para alterar.' : 'Adicionar link exato do Sam\\'s Club'}">
                                    ${temLinkSams ? '🔗' : '⛓️‍💥'}
                                </button>
                                
                                <!-- Botão do Sino de Alerta do Crawler -->
                                <button onclick="toggleMonitoramentoWeb('${nomeSeguro.replace(/'/g, "\\'")}', ${!isMonitorado}, this)" 
                                        class="text-[11px] transition-all active:scale-90 ${classeSino}" 
                                        title="${isMonitorado ? 'Monitorando preço baixo' : 'Ativar alerta de preço baixo'}">
                                    ${iconeSino}
                                </button>
                            </div>
                        </div>
                        
                        <button onclick="adicionarDiretoALista('${nomeSeguro}')" class="bg-blue-50 text-blue-600 px-3 py-2 rounded-lg text-xs font-bold active:scale-90">🛒+</button>
                    </div>`;
            });
            container.appendChild(div);
        }

        if (typeof categoriaSelecionadaFiltro !== 'undefined' && categoriaSelecionadaFiltro !== "TUDO") {
            filtrarPorCorredor(categoriaSelecionadaFiltro);
        }

    } catch (e) {
        console.error("Erro ao renderizar o dicionário:", e);
    }
}

/**
 * Dispara a ativação/desativação do monitoramento do crawler pelo botão do sino
 */
/**
 * Dispara a ativação/desativação do monitoramento do crawler pelo botão do sino
 */
async function toggleMonitoramentoWeb(nomeProduto, ativar, elementoBotao) {
    try {
        // Usa o fetch direto para evitar erros de importação do api.js
        const response = await fetch('/api/VincularProdutos', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item: nomeProduto.toUpperCase(), monitorar: ativar })
        });

        if (!response.ok) throw new Error("A API recusou a atualização");

        const nomeEscapado = nomeProduto.replace(/'/g, "\\'");

        // Altera visualmente o botão (Muda o Emoji e aplica fundo/filtros)
        if (ativar) {
            elementoBotao.className = "text-[11px] transition-all p-1 active:scale-90 bg-green-100 rounded-full shadow-sm border border-green-300 scale-110";
            elementoBotao.innerHTML = "🔔"; // Emoji normal (Sino ligado)
            elementoBotao.setAttribute('onclick', `toggleMonitoramentoWeb('${nomeEscapado}', false, this)`);
            elementoBotao.title = "Monitorando preço baixo";
        } else {
            elementoBotao.className = "text-[11px] transition-all p-1 active:scale-90 grayscale opacity-40 hover:opacity-80 bg-gray-50 rounded-full";
            elementoBotao.innerHTML = "🔕"; // Sino cortado e em preto e branco
            elementoBotao.setAttribute('onclick', `toggleMonitoramentoWeb('${nomeEscapado}', true, this)`);
            elementoBotao.title = "Ativar alerta de preço baixo";
        }
    } catch (err) {
        console.error("Erro ao alternar monitoramento:", err);
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
    }
}

// ================== MANIPULAÇÃO DA LISTA ==================

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

async function deletarItem(nome) {
    if (!confirm(`Remover ${nome} da lista?`)) return;
    try {
        await fetch(`/api/GerenciarLista?nome=${encodeURIComponent(nome)}`, { method: 'DELETE' });
        // Remove também os preços digitados no localStorage
        if (window.precosDigitadosNoMercado && window.precosDigitadosNoMercado[nome]) {
            delete window.precosDigitadosNoMercado[nome];
            localStorage.setItem('precosLive', JSON.stringify(window.precosDigitadosNoMercado));
        }
        carregarLista();
    } catch (e) { console.error(e); }
}

async function finalizarCompra() {
    if (!confirm("Deseja limpar toda a lista?")) return;
    try {
        // Limpa lista ativa e preços temporários no MongoDB
        await Promise.all([
            fetch('/api/GerenciarLista', { method: 'DELETE' }),
            fetch('/api/GerenciarPrecosTemp', { method: 'DELETE' })
        ]);

        window.precosDigitadosNoMercado = {};
        localStorage.removeItem('precosLive');

        // Recarrega a interface
        carregarLista();
        const display = document.getElementById('total-real-dinamico');
        if (display) display.innerText = "R$ 0,00";

    } catch (e) {
        console.error("Erro ao finalizar compra:", e);
    }
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
        // Primeiro, consulta sem salvar
        let response = await fetch('/api/ProcessarNota', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, consulta: true })
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
            body: JSON.stringify({ url, apelido: apelidoFinal })
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
    if (novoNome === null) return;
    const nomeFinal = novoNome.trim().toUpperCase();
    const categoriaSugerida = sugerirCategoria(nomeFinal);
    const cat = prompt(`Categoria:`, categoriaSugerida);
    if (cat === null) return;
    const foto = prompt(`URL da Foto (Deixe vazio para manter a atual):`, "");
    fetch('/api/VincularProdutos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idPrincipal: id, nomePadrao: nomeFinal, categoria: cat.toUpperCase(), fotoUrl: foto })
    }).then(() => {
        processarUrlManual();
        renderizarDicionario();
    });
}

// ================== ALERTA DE PREÇO ==================

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

// ================== RANKING TOP 10 ==================

async function renderizarRankingTopCompras() {
    const container = document.getElementById('lista-gastos-detalhada');
    if (!container) return;
    container.innerHTML = '<p class="text-center text-gray-400 text-[10px] animate-pulse py-8">CALCULANDO...</p>';
    try {
        const response = await fetch('/api/ObterRankingTopCompras');
        const dados = await response.json();
        let html = `<div class="mt-8"><h3 class="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-4 text-center">🏆 TOP 10 PRODUTOS (VOLUME)</h3><div class="space-y-2">`;
        dados.forEach((item, index) => {
            html += `
                <div onclick="abrirGrafico('${item._id}')" class="bg-white p-3 rounded-2xl border border-gray-100 shadow-sm flex items-center gap-4 cursor-pointer hover:bg-blue-50 transition-colors">
                    <span class="text-lg font-black text-blue-200">#${index + 1}</span>
                    <img src="${item.foto || 'https://via.placeholder.com/50'}" class="w-10 h-10 rounded-lg object-cover bg-gray-50">
                    <div class="flex-1"><p class="text-[10px] font-black text-gray-700 uppercase">${item._id}</p><p class="text-[9px] text-gray-400 font-bold">${item.vezesComprado} notas fiscais</p></div>
                    <div class="text-right"><p class="text-sm font-black text-blue-600">${item.totalQtd} un</p><p class="text-[8px] text-gray-400">R$ ${item.totalGasto.toFixed(2)} total</p></div>
                </div>`;
        });
        html += `</div></div>`;
        container.innerHTML = html;
    } catch (e) { console.error(e); }
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
                datasets: [{ label: 'Preço Médio (R$)', data: dados.map(d => d.precoMedio), backgroundColor: 'rgba(54, 162, 235, 0.6)', borderRadius: 8 }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => dados[c[0].dataIndex]._id, label: (c) => `Média: R$ ${c.parsed.y.toFixed(2)}` } } } }
        });
    } catch (e) { console.error(e); }
}

// ================== SUGESTÕES AUTOCOMPLETE ==================

async function carregarSugestoes() {
    try {
        const response = await fetch('/api/VincularProdutos');
        const produtos = await response.json();
        const datalist = document.getElementById('sugestoes-produtos');
        if (datalist) {
            datalist.innerHTML = [...new Set(produtos.map(p => p.nome_comum))].map(nome => `<option value="${nome.toUpperCase()}">`).join('');
        }
    } catch (e) { }
}

/**
 * Busca os preços temporários salvos no MongoDB e popula a interface.
 * Garante que os dados sejam os mesmos em qualquer dispositivo.
 */
async function hidratarPrecosTemporarios() {
    try {
        const response = await fetch('/api/GerenciarPrecosTemp');
        const dados = await response.json();

        if (dados && dados.length > 0) {
            window.precosDigitadosNoMercado = {};
            dados.forEach(reg => {
                if (!window.precosDigitadosNoMercado[reg.item]) {
                    window.precosDigitadosNoMercado[reg.item] = {};
                }
                window.precosDigitadosNoMercado[reg.item][reg.loja] = reg.preco;
            });

            // IMPORTANTE: Atualiza o Ranking e os inputs na tela
            recalcularRankingLive(window.dadosOriginaisDicionario?.ranking || []);

            // Opcional: Atualizar os campos visíveis se o usuário não estiver digitando neles
            const inputs = document.querySelectorAll('.input-preco-mercado');
            // ... lógica para atualizar valores nos inputs ...
        }
    } catch (e) { console.error("Erro na sincronização:", e); }
}

// Verifica novos preços no banco a cada 5 segundos
setInterval(() => {
    // Só busca se a página não estiver oculta (economiza bateria/dados)
    if (!document.hidden) {
        hidratarPrecosTemporarios();
    }
}, 5000);

/**
 * Gera as pílulas de filtros de categoria com base nos itens presentes na lista.
 */
function renderizarFiltrosCategorias() {
    const secaoFiltros = document.getElementById('secao-filtros-categorias');
    const container = document.getElementById('container-categorias-filtro');
    if (!container || !secaoFiltros) return;

    // Relação fixa de todos os seus corredores do mercado
    const todosOsCorredores = [
        "TUDO",
        "HORTIFRUTI",
        "FRIOS E CONGELADOS",
        "MERCEARIA",
        "AÇOUGUE E PEIXARIA",
        "BEBIDAS",
        "LIMPEZA",
        "HIGIENE E PERFUMARIA",
        "PADARIA E MATINAIS",
        "DESCARTÁVEIS E EMBALAGENS",
        "OUTROS"
    ];

    secaoFiltros.classList.remove('hidden');
    container.innerHTML = '';

    // Cria as pílulas na tela de forma estável
    todosOsCorredores.forEach(corredor => {
        const label = corredor === "TUDO" ? "📍 TUDO" : corredor;
        const btn = criarBotaoPilula(corredor, label);
        container.appendChild(btn);
    });
}

function criarBotaoPilula(idCategoria, label) {
    const botao = document.createElement('button');
    const isActive = categoriaSelecionadaFiltro === idCategoria;

    botao.className = `px-3 py-1.5 rounded-full text-[10px] font-black tracking-wider uppercase whitespace-nowrap border transition-all ${isActive
        ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
        : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
        }`;
    botao.innerText = label;
    botao.onclick = () => filtrarPorCorredor(idCategoria);
    return botao;
}

/**
 * Filtra visualmente os elementos da lista sem precisar recarregar dados do banco.
 * Atualiza o ranking do topo para somar apenas o corredor visível.
 */
/**
 * Filtra visualmente os elementos da Lista Ativa E do Dicionário
 * sem precisar recarregar dados do banco.
 */
function filtrarPorCorredor(idCategoria) {
    categoriaSelecionadaFiltro = idCategoria;

    // 1. Atualiza visual dos botões do filtro
    const botoes = document.querySelectorAll('#container-categorias-filtro button');
    botoes.forEach(btn => {
        const text = btn.innerText.replace('📍 ', '').trim().toUpperCase();
        if (text === idCategoria.toUpperCase()) {
            btn.className = "px-3 py-1.5 rounded-full text-[10px] font-black tracking-wider uppercase whitespace-nowrap border bg-blue-600 text-white border-blue-600 shadow-sm";
        } else {
            btn.className = "px-3 py-1.5 rounded-full text-[10px] font-black tracking-wider uppercase whitespace-nowrap border bg-white text-gray-500 border-gray-200 hover:bg-gray-50";
        }
    });

    // 2. Filtra divisórias de corredores na Lista Ativa
    const headers = document.querySelectorAll('#lista-ativa .header-corredor');
    headers.forEach(h => {
        const catHeader = h.getAttribute('data-categoria');
        if (idCategoria === "TUDO" || catHeader === idCategoria.toUpperCase()) {
            h.classList.remove('hidden');
        } else {
            h.classList.add('hidden');
        }
    });

    // 3. Filtra os cards dos produtos na Lista Ativa
    const cards = document.querySelectorAll('#lista-ativa .card-produto-lista');
    cards.forEach(card => {
        const catCard = card.getAttribute('data-categoria-produto');
        if (idCategoria === "TUDO" || catCard === idCategoria.toUpperCase()) {
            card.classList.remove('hidden');
        } else {
            card.classList.add('hidden');
        }
    });

    // ==========================================
    // 🔥 NOVO: FILTRO PARA O DICIONÁRIO
    // ==========================================
    // Garanta que os itens renderizados na tabela/lista do dicionário possuam 
    // a classe '.item-dicionario-lista' e o atributo 'data-categoria-dict'
    const itensDict = document.querySelectorAll('#container-dicionario .item-dicionario-lista, #tabela-dicionario tr[data-categoria-dict]');
    itensDict.forEach(item => {
        const catDict = item.getAttribute('data-categoria-dict');
        if (idCategoria === "TUDO" || (catDict && catDict.toUpperCase() === idCategoria.toUpperCase())) {
            item.classList.remove('hidden');
        } else {
            item.classList.add('hidden');
        }
    });

    // Localize o final da sua função filtrarPorCorredor(idCategoria) no script.js e substitua a parte do dicionário por esta:

    // 4. Filtra os blocos de categorias na aba do Dicionário
    const blocosDict = document.querySelectorAll('.block-categoria-dicionario');
    blocosDict.forEach(bloco => {
        const catBloco = bloco.getAttribute('data-categoria-dict');
        if (idCategoria === "TUDO" || (catBloco && catBloco.toUpperCase() === idCategoria.toUpperCase())) {
            bloco.classList.remove('hidden'); // Reexibe o bloco inteiro
        } else {
            bloco.setAttribute('class', 'mb-4 block-categoria-dicionario hidden'); // Oculta o bloco completo
        }
    });

    // Exemplo de função que alterna para o Dicionário
    function irParaAbaDicionario() {
        document.getElementById('secao-lista').classList.add('hidden');
        document.getElementById('secao-dicionario').classList.remove('hidden');

        // Força o filtro a voltar para o estado padrão ao mudar de aba, evitando confusão
        filtrarPorCorredor("TUDO");
    }

    // Força a atualização do ranking no topo para os itens visíveis
    if (window.dadosOriginaisDicionario) {
        atualizarPrecosEPilulas();
    }
}

/**
 * Salva a URL exata do produto em um mercado específico
 */
export async function salvarUrlMercado(nomeProduto, loja, url) {
    return fetch('/api/VincularProdutos', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: nomeProduto.toUpperCase(), loja: loja, url: url })
    });
}

/**
 * Abre um prompt para o usuário colar o link do produto no site do mercado
 */
async function inserirLinkLoja(nomeProduto, loja) {
    const url = prompt(`Cole o link exato do produto "${nomeProduto}" no site do ${loja === 'SAMS' ? "Sam's Club" : loja}:`);
    
    if (!url) return; // Se o usuário cancelar ou deixar em branco, não faz nada

    try {
        // Usa o fetch direto para evitar erros de escopo/importação
        const response = await fetch('/api/VincularProdutos', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item: nomeProduto.toUpperCase(), loja: loja, url: url.trim() })
        });

        if (response.ok) {
            alert(`Link do ${loja} salvo com sucesso para o robô!`);
            renderizarDicionario(); // Recarrega a tela para a corrente acender 🔗
        } else {
            alert("Erro ao salvar o link no banco de dados.");
        }
    } catch (e) {
        console.error("Erro ao salvar link:", e);
        alert("Erro de comunicação com o servidor.");
    }
}

// ================== INICIALIZAÇÃO ==================
renderizarFiltrosCategorias();
carregarLista();
carregarSugestoes();
hidratarPrecosTemporarios();
