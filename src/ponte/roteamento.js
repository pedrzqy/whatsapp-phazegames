'use strict';

/**
 * Qual conversa (fornecedor) atende cada login.
 *
 * Dois fornecedores, uma regra só: login cujo e-mail termina num dos domínios
 * de PONTE_SELLER2_DOMINIOS (padrão exctp.com) SÓ consegue código na loja 2;
 * todo o resto vai para a principal (PONTE_SELLER_CHAT_TITLE).
 *
 * A decisão é por LOGIN, não por atendimento ou cliente: é o login que a loja
 * reconhece. E fica gravada na tarefa (`chatTitulo`) para o braço abrir a
 * conversa certa e para a resposta ser conferida contra ela depois.
 *
 * Módulo sem estado e sem I/O — só lê a config — para ser trivial de testar.
 */

const cfg = require('./config');

/** Domínio do e-mail, minúsculo; '' se o login não é e-mail. */
function dominioDe(usuario) {
  const s = String(usuario || '').trim().toLowerCase();
  const i = s.lastIndexOf('@');
  return i >= 0 ? s.slice(i + 1).trim() : '';
}

/** Este login só pode ser atendido pelo fornecedor 2? */
function ehDoFornecedor2(usuario) {
  if (!cfg.vendedor.chatTitulo2) return false; // loja 2 não configurada: tudo no principal
  const d = dominioDe(usuario);
  return Boolean(d) && cfg.vendedor.dominios2.includes(d);
}

/** Título da conversa que atende este login. */
function chatTituloPara(usuario) {
  return ehDoFornecedor2(usuario) ? cfg.vendedor.chatTitulo2 : cfg.vendedor.chatTitulo;
}

/** Todos os títulos configurados (sem vazios nem repetidos). */
function titulos() {
  return [...new Set([cfg.vendedor.chatTitulo, cfg.vendedor.chatTitulo2].filter(Boolean))];
}

module.exports = { dominioDe, ehDoFornecedor2, chatTituloPara, titulos };
