'use strict';

/**
 * Envio humanizado do fluxo do código de segurança.
 *
 * Duas camadas sobre o sender, ambas para não parecer disparo automático:
 *
 *  1. POR MENSAGEM: "digitando..." (presence composing) e uma espera
 *     proporcional ao tamanho do texto antes de enviar, mais um jitter entre
 *     mensagens seguidas para o mesmo cliente. Cada mensagem espera por conta
 *     própria (async): nada aqui trava a fila nem o tick.
 *
 *  2. GLOBAL: no pico, dezenas de clientes disparam o fluxo no mesmo segundo.
 *     Cada envio reserva uma vaga na linha do tempo, com um espaçamento
 *     aleatório (padrão 0,7–1,5 s) depois da vaga anterior. As vagas são
 *     reservadas de forma síncrona, então a ordem é preservada e NADA é
 *     descartado: só atrasa o que passaria do ritmo.
 *
 * O código em si usa `rapido`: espera curta (até 2,5 s) — o cliente está
 * olhando a tela esperando por ele.
 *
 * PONTE_HUMANIZA=false desliga tudo (testes): vira um sender.send direto.
 */

const cfg = require('./config');
const sender = require('../sender');
const evolution = require('../evolution');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * Math.max(0, max - min));

/** Próxima vaga livre de envio (global). */
let proximoEnvio = 0;
/** Último envio reservado por cliente. */
const ultimoDoCliente = new Map();

/** Quanto "digitar" um texto: proporcional ao tamanho, com teto, e um pouco de ruído. */
function tempoDigitando(texto, rapido) {
  const len = String(texto || '').length;
  const min = rapido ? cfg.humanizaRapidoMinMs : cfg.humanizaMinMs;
  const max = rapido ? cfg.humanizaRapidoMaxMs : cfg.humanizaMaxMs;
  const base = min + len * cfg.humanizaMsPorChar;
  const ruido = 0.85 + Math.random() * 0.3;
  return Math.round(Math.min(max, Math.max(min, base * ruido)));
}

/**
 * Reserva a vaga de envio. Síncrona de propósito: duas chamadas no mesmo
 * instante recebem vagas diferentes e em ordem.
 */
function reservar(from, digitando) {
  const agora = Date.now();
  const doCliente = (ultimoDoCliente.get(from) || 0) + rand(cfg.humanizaJitterMinMs, cfg.humanizaJitterMaxMs);
  const envioEm = Math.max(agora + digitando, proximoEnvio, doCliente);
  proximoEnvio = envioEm + rand(cfg.humanizaEspacoMinMs, cfg.humanizaEspacoMaxMs);
  ultimoDoCliente.set(from, envioEm);
  if (ultimoDoCliente.size > 2000) {
    for (const [k, t] of ultimoDoCliente) if (agora - t > 60 * 60 * 1000) ultimoDoCliente.delete(k);
  }
  return envioEm;
}

/**
 * Mesma assinatura do sender.send, com `opts.rapido` a mais.
 * Resolve quando a mensagem realmente sai; rejeita como o sender rejeitaria.
 */
async function enviar(from, texto, opts = {}) {
  const { rapido, ...resto } = opts;
  // Cliente do site não vê "digitando", e a espera só atrasaria a fila.
  if (!cfg.humaniza || String(from || '').startsWith('web:')) return sender.send(from, texto, resto);

  const digitando = tempoDigitando(texto, rapido);
  const envioEm = reservar(from, digitando);

  // Espera até a hora de COMEÇAR a digitar; depois digita; depois envia.
  const antes = envioEm - digitando - Date.now();
  if (antes > 0) await dormir(antes);

  const evoOpts = resto.instance ? { instance: resto.instance } : {};
  try { await evolution.sendPresence(from, 'composing', evoOpts); } catch { /* não bloqueia o envio */ }
  const resta = envioEm - Date.now();
  if (resta > 0) await dormir(resta);

  // O sender já não precisa simular digitação nem "reação": foi feito acima.
  return sender.send(from, texto, { ...resto, reaction: false, typing: false });
}

/** Só para teste. */
function zerar() {
  proximoEnvio = 0;
  ultimoDoCliente.clear();
}

module.exports = { enviar, tempoDigitando, zerar };
