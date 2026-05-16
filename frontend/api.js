// frontend/api.js

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