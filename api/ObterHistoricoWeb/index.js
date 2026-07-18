async function autoPreencherPrecos() {
    try {
        const response = await fetch('/api/ObterPrecosHistoricoWeb'); // Nova API isolada
        const historico = await response.json(); // Lista: [{ nome: "...", loja: "...", preco: 10.00 }]

        let preenchidos = 0;

        // Itera sobre todos os cards de produtos da tela
        document.querySelectorAll('.card-produto-lista').forEach(card => {
            // Extraímos o nome que você já definiu no atributo data-produto
            const nomeProduto = card.getAttribute('data-produto');
            
            // Busca os inputs de preço dentro deste card específico
            const inputs = card.querySelectorAll('input[oninput*="registrarPrecoLive"]');
            
            inputs.forEach(input => {
                // Descobre a loja olhando o texto do label logo acima do input
                const label = input.parentElement.querySelector('.uppercase')?.innerText || "";
                const loja = label.toUpperCase();

                // Procura no histórico
                const registro = historico.find(h => 
                    h.nome.trim().toUpperCase() === nomeProduto.trim().toUpperCase() && 
                    h.loja.trim().toUpperCase().includes(loja)
                );

                if (registro && registro.preco > 0) {
                    input.value = registro.preco.toFixed(2).replace('.', ',');
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    preenchidos++;
                }
            });
        });

        if (preenchidos > 0) alert(`${preenchidos} preços preenchidos!`);
        else alert("Nenhum preço encontrado para os itens da lista.");

    } catch (e) {
        console.error("Erro:", e);
        alert("Erro ao conectar com histórico.");
    }
}