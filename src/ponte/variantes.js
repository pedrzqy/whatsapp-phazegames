'use strict';

/**
 * Variações de texto do fluxo do código de segurança.
 *
 * POR QUE EXISTE: o número da loja foi restringido pelo WhatsApp no pico de
 * vendas, e uma das suspeitas é a mesma mensagem, palavra por palavra, saindo
 * para dezenas de clientes em poucos segundos. Aqui cada mensagem do fluxo tem
 * 3 formas com o mesmo conteúdo essencial, e `escolher` sorteia uma.
 *
 * REGRAS DO SORTEIO (memória simples, em RAM — reiniciar zera e não faz mal):
 *  - nunca a mesma forma duas vezes seguidas para o MESMO cliente;
 *  - nunca a mesma forma duas vezes seguidas no envio global dessa mensagem;
 *  - se as duas regras juntas não deixam sobrar nada (lista pequena), vale só a
 *    do cliente; se nem essa deixa, sorteia qualquer uma.
 *
 * Uma variante pode ser função (recebe os argumentos extras de `escolher`), para
 * as que levam número, código ou prazo.
 */

/** chave -> índice da última variante enviada (global). */
const ultimoGlobal = new Map();
/** `${destino}|${chave}` -> { i, em } da última enviada àquele cliente. */
const ultimoPorCliente = new Map();

const GUARDA_MS = 6 * 60 * 60 * 1000;
const GUARDA_MAX = 5000;

function limpar(agora) {
  if (ultimoPorCliente.size <= GUARDA_MAX) return;
  for (const [k, v] of ultimoPorCliente) {
    if (agora - v.em > GUARDA_MS) ultimoPorCliente.delete(k);
  }
}

/**
 * @param {string} chave        identifica a mensagem (ex.: 'pede_usuario')
 * @param {Array<string|Function>} variantes
 * @param {string} [destino]    cliente (número); sem ele só vale a regra global
 * @param {...any} args         repassados às variantes que são função
 * @returns {string}
 */
function escolher(chave, variantes, destino, ...args) {
  const n = variantes.length;
  let i = 0;
  if (n > 1) {
    const agora = Date.now();
    const kc = `${destino || ''}|${chave}`;
    const doCliente = destino ? ultimoPorCliente.get(kc)?.i : undefined;
    const global = ultimoGlobal.get(chave);
    const todos = variantes.map((_, k) => k);
    let cand = todos.filter((k) => k !== doCliente && k !== global);
    if (!cand.length) cand = todos.filter((k) => k !== doCliente);
    if (!cand.length) cand = todos;
    i = cand[Math.floor(Math.random() * cand.length)];
    ultimoGlobal.set(chave, i);
    if (destino) {
      ultimoPorCliente.set(kc, { i, em: agora });
      limpar(agora);
    }
  }
  const v = variantes[i];
  return typeof v === 'function' ? v(...args) : v;
}

/** Só para teste: zera a memória do rodízio. */
function zerar() {
  ultimoGlobal.clear();
  ultimoPorCliente.clear();
}

/** "1 pessoa" / "3 pessoas", já em negrito. */
const pessoas = (n) => `*${n} ${n === 1 ? 'pessoa' : 'pessoas'}*`;

module.exports = { escolher, zerar, pessoas };
