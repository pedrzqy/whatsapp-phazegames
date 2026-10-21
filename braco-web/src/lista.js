'use strict';

/**
 * Escolha da conversa na lista lateral — lógica PURA, sem navegador.
 *
 * Antes o braço clicava no PRIMEIRO item e só conferia o título depois. Quando
 * OUTRA loja mandava mensagem, a conversa dela subia para o topo, a conferência
 * falhava e o sistema inteiro parava por horas. Agora o item é escolhido pelo
 * título, esteja onde estiver na lista.
 */

/** Normaliza para comparar: NFKC (largura cheia vira normal), sem espaços/invisíveis, minúsculo. */
function normalizar(t) {
  return String(t || '')
    .normalize('NFKC')
    .replace(/[​-‏⁠﻿\s]+/g, '')
    .toLowerCase();
}

/**
 * Índice do item que é a conversa `titulo`, ou -1.
 *
 * `itens`: [{ texto, visivel }] na ordem do DOM. Prefere um item visível; se o
 * único que casa está fora da vista (lista virtualizada), devolve esse mesmo,
 * e quem chama decide rolar até ele. Título vazio nunca casa (casaria tudo).
 */
function escolherConversa(itens, titulo) {
  const alvo = normalizar(titulo);
  if (!alvo || !Array.isArray(itens)) return -1;
  let reserva = -1;
  for (let i = 0; i < itens.length; i++) {
    if (!normalizar(itens[i]?.texto).includes(alvo)) continue;
    if (itens[i].visivel !== false) return i;
    if (reserva < 0) reserva = i;
  }
  return reserva;
}

module.exports = { normalizar, escolherConversa };
