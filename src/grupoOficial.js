'use strict';

/**
 * GRUPO OFICIAL da comunidade: JID e link de convite, num lugar só.
 *
 * Quem posta, abre/fecha o portão, conta membros ou cita o link do grupo lê
 * DAQUI, na hora de usar (nunca guardado no carregamento do módulo). Assim o
 * #grupo, mandado de dentro do grupo novo, vale sem reiniciar nada.
 *
 * PRECEDÊNCIA (do mais forte ao mais fraco):
 *   1. o que o #grupo registrou (ponte.json, no volume /app/data — sobrevive a deploy)
 *   2. COMMUNITY_GROUP_JID / STORE_GROUP_URL (env, via config.js)
 *
 * O registro VENCE a env de propósito: o dono opera pelo celular e não consegue
 * mexer na env do Easypanel. Para voltar à env: `#grupo env`.
 */

const config = require('./config');

const registrado = () => require('./ponte/estado').dados.grupoComunidade || null;

/** JID do grupo oficial em vigor ('' se não há). */
function jid() {
  return registrado()?.jid || config.community.groupJid || '';
}

/** Link de convite em vigor: o buscado no registro, senão o da env. */
function url() {
  return registrado()?.url || config.store.groupUrl;
}

/** O que foi registrado pelo #grupo, ou null (diagnóstico). */
function dadosRegistrados() {
  return registrado();
}

/**
 * Registra o grupo. `url` null mantém o link da env (o link antigo pertencia
 * ao grupo anterior, então nunca é herdado).
 */
function registrar({ jid: novo, nome = '', url: link = null }) {
  const est = require('./ponte/estado');
  const mudou = jid() !== novo;
  est.dados.grupoComunidade = { jid: novo, nome, url: link || null, em: Date.now() };
  est.persistAgora();
  if (mudou) aoMudarDeGrupo();
  return { mudou };
}

/** Volta a valer a env. */
function limpar() {
  const est = require('./ponte/estado');
  const mudou = Boolean(registrado());
  est.dados.grupoComunidade = null;
  est.persistAgora();
  if (mudou) aoMudarDeGrupo();
}

// O que era do grupo antigo não vale para o novo: o estado do portão (aberto ou
// fechado, tentativas, trava manual) e o retrato de membros do resumo. Os slots
// por dia NÃO são zerados: eles dizem "este anúncio já saiu hoje", e zerar faria
// o mesmo anúncio sair duas vezes no mesmo dia.
function aoMudarDeGrupo() {
  try { require('./community').grupoMudou(); } catch (err) { console.warn('[grupo] community:', err.message); }
  try { require('./resumo').grupoMudou(); } catch (err) { console.warn('[grupo] resumo:', err.message); }
}

module.exports = { jid, url, registrar, limpar, dadosRegistrados };
