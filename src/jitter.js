'use strict';

/**
 * Variacao de horario e de texto dos envios agendados.
 *
 * O numero da loja foi RESTRINGIDO no pico de vendas, e o dono notou o padrao:
 * os anuncios do grupo saiam no mesmo minuto todo dia, com o mesmo texto. Isso
 * e assinatura de robo. Este arquivo tira as duas assinaturas:
 *
 *  - HORARIO: cada item agendado sai no horario-base + um desvio (em minutos)
 *    sorteado por dia. O desvio de hoje difere do de ontem em pelo menos
 *    MIN_DIFF minutos, entao dois dias seguidos nunca saem quase no mesmo minuto.
 *  - TEXTO: sorteia uma variacao que NAO e a ultima usada.
 *
 * Nada aqui guarda estado em disco. Quem chama passa o mapa/objeto que ja
 * persiste (community.json, resumo.json), e e isso que impede reinicio de
 * re-sortear o horario do dia ou repetir o texto.
 */

/** Meia-largura da janela de desvio, em minutos (sorteia de -FAIXA a +FAIXA). */
const FAIXA = Number(process.env.COMMUNITY_JITTER_MIN ?? 30);
/** Diferenca minima, em minutos, entre o desvio de um dia e o do dia anterior. */
const MIN_DIFF = Number(process.env.COMMUNITY_JITTER_MIN_DIFF ?? 15);
/** Quantos dias de historico ficam no mapa. */
const DIAS_GUARDADOS = 10;

/**
 * Desvio (minutos) de um dia. Sorteia uma vez e guarda em `mapa[dateKey]`;
 * chamadas seguintes (inclusive depois de reinicio) devolvem o mesmo numero.
 *
 * @param {Record<string, number>} mapa  desvios por dia (AAAA-MM-DD), persistido por quem chama
 * @param {string} dateKey
 * @param {{faixa?:number, minDiff?:number, rand?:()=>number}} [op]
 * @returns {number}
 */
function desvioDoDia(mapa, dateKey, { faixa = FAIXA, minDiff = MIN_DIFF, rand = Math.random } = {}) {
  if (Number.isFinite(mapa[dateKey])) return mapa[dateKey];

  // O dia ANTERIOR mais recente que temos (se faltou um dia, vale o ultimo).
  const anteriores = Object.keys(mapa).filter((k) => k < dateKey).sort();
  const ontem = anteriores.length ? mapa[anteriores[anteriores.length - 1]] : null;

  const todos = [];
  for (let m = -faixa; m <= faixa; m++) todos.push(m);
  let candidatos = ontem == null ? todos : todos.filter((m) => Math.abs(m - ontem) >= minDiff);
  if (!candidatos.length) {
    // Faixa estreita demais para a diferenca pedida: fica com o ponto mais distante.
    candidatos = [Math.abs(-faixa - ontem) >= Math.abs(faixa - ontem) ? -faixa : faixa];
  }
  const desvio = candidatos[Math.floor(rand() * candidatos.length)];

  mapa[dateKey] = desvio;
  const chaves = Object.keys(mapa).sort();
  for (const k of chaves.slice(0, Math.max(0, chaves.length - DIAS_GUARDADOS))) delete mapa[k];
  return desvio;
}

/**
 * Sorteia uma variacao diferente da ultima usada.
 *
 * @param {string[]} lista
 * @param {number|null|undefined} ultimo  indice usado por ultimo
 * @param {() => number} [rand]
 * @returns {{texto:string, indice:number}}
 */
function variar(lista, ultimo, rand = Math.random) {
  const livres = lista.map((_, i) => i).filter((i) => i !== ultimo);
  const pool = livres.length ? livres : [0];
  const indice = pool[Math.floor(rand() * pool.length)];
  return { texto: lista[indice], indice };
}

module.exports = { desvioDoDia, variar, FAIXA, MIN_DIFF };
