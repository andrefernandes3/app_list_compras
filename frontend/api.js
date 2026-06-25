export async function buscarListaAtiva() {
    const res = await fetch('/api/GerenciarLista');
    return res.json();
}

export async function buscarVinculosDicionario() {
    const res = await fetch('/api/VincularProdutos');
    return res.json();
}

export async function buscarComparativoPrecos() {
    const res = await fetch('/api/CompararPrecos');
    return res.json();
}

export async function persistirPrecoTemporario(nome, loja, preco) {
    return fetch('/api/GerenciarPrecosTemp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: nome.toUpperCase(), loja: loja.toUpperCase(), preco: parseFloat(preco) })
    });
}

export async function buscarPrecosTemporarios() {
    const res = await fetch('/api/GerenciarPrecosTemp');
    return res.json();
}

export async function limparSessaoCompras() {
    return Promise.all([
        fetch('/api/GerenciarLista', { method: 'DELETE' }),
        fetch('/api/GerenciarPrecosTemp', { method: 'DELETE' })
    ]);
}

/**
 * Ativa ou desativa o monitoramento de preço baixo para um produto do dicionário.
 */
export async function alternarMonitoramentoProduto(nomeProduto, monitorarStatus) {
    return fetch('/api/VincularProdutos', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: nomeProduto.toUpperCase(), monitorar: monitorarStatus })
    });
}

// --- NOVAS FUNÇÕES DO DICIONÁRIO / MONITORAMENTO ---

async function obterDicionario() {
    const res = await fetch(`${API_BASE}/GerenciarDicionario`);
    return await res.json();
}

async function atualizarItemDicionario(id, monitorar, preco_alvo) {
    await fetch(`${API_BASE}/GerenciarDicionario`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, monitorar, preco_alvo })
    });
}

async function desmarcarTodosDicionario() {
    await fetch(`${API_BASE}/GerenciarDicionario`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'desmarcar_todos' })
    });
}