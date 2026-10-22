'use strict';

/**
 * Qual conversa (fornecedor) atende cada login.
 *
 * Dois fornecedores, uma regra só: login cujo e-mail termina num dos domínios
 * de PONTE_SELLER2_DOMINIOS (padrão exrctp.com,exctp.com) SÓ consegue código na loja 2;
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

/**
 * Login de e-mail da loja 2, já corrigido; null se não é de um domínio dela.
 *
 * O cliente digita "x@exrctp" (sem o .com), "x@@exrctp.com", "X@EXRCTP.COM" ou
 * "x@exrctp.con". Tudo isso vira "x@exrctp.com" (o domínio completo da config).
 * A tolerância vale SÓ para os domínios configurados, pelo nome antes do TLD:
 * "x@gmail.com" e "x@exctp.com.br" continuam fora. O fornecedor e o roteamento
 * recebem sempre este valor normalizado.
 */
function normalizarLogin(usuario) {
  if (!cfg.vendedor.chatTitulo2) return null; // loja 2 não configurada: tudo no principal
  const s = String(usuario || '').trim().toLowerCase().replace(/@{2,}/g, '@').replace(/\.+$/, '');
  const i = s.lastIndexOf('@');
  if (i < 1) return null;
  const local = s.slice(0, i);
  const dom = s.slice(i + 1);
  if (!/^[a-z0-9._+-]{1,40}$/.test(local) || !dom) return null;
  for (const d of cfg.vendedor.dominios2) {
    const base = d.split('.')[0];
    if (dom === d || dom === base || (base && new RegExp(`^${base}\.(con|co|cm|comm)$`).test(dom))) {
      return `${local}@${d}`;
    }
  }
  return null;
}

/** Este login só pode ser atendido pelo fornecedor 2? */
function ehDoFornecedor2(usuario) {
  return normalizarLogin(usuario) !== null;
}

/** Título da conversa que atende este login. */
function chatTituloPara(usuario) {
  return ehDoFornecedor2(usuario) ? cfg.vendedor.chatTitulo2 : cfg.vendedor.chatTitulo;
}

/** Todos os títulos configurados (sem vazios nem repetidos). */
function titulos() {
  return [...new Set([cfg.vendedor.chatTitulo, cfg.vendedor.chatTitulo2].filter(Boolean))];
}

module.exports = { normalizarLogin, dominioDe, ehDoFornecedor2, chatTituloPara, titulos };
