'use strict';

/**
 * Avanço da fila para o cliente que espera.
 *
 * Ele ouvia "tem N pessoas na sua frente" uma vez e depois silêncio até a vez
 * chegar. Aqui a fila "fala" com moderação: no máximo DOIS avisos extras por
 * atendimento, e só quando a notícia é boa de verdade.
 *
 *   - "perto": quem ouviu mais de 3 na frente e agora tem 2 ou 3.
 *   - "próximo": quem ouviu mais de 1 e agora só tem o atendimento em curso
 *     à frente. É o aviso que deixa o cliente de prontidão.
 *
 * Quem entrou já com 1 ou 2 na frente não recebe "perto" (nada mudou de
 * relevante) e quem ouviu 1 não recebe "próximo" (já sabe).
 *
 * Congelado, não fala: durante o congelamento o cliente já ouviu a instabilidade
 * e um "você é o próximo" seria promessa que não depende da fila. Os flags ficam
 * no atendimento (fila) ou no registro da espera (recepcao), então sobrevivem a
 * deploy e nada sai duas vezes.
 *
 * Cobre as duas filas: a de quem já entregou foto + login (fila.js) e a espera
 * da entrada (esperando_vez), cuja posição vem de recepcao.quantosNaFrente.
 */

const cfg = require('./config');
const fila = require('./fila');
const limites = require('./limites');
const { persistAgora } = require('./estado');
const humaniza = require('./humaniza');
const variantes = require('./variantes');

// 3 formas de cada aviso (variantes.js); a #1 é o texto original.
const VARIANTES_PROXIMO = [
  'Agora você é o *próximo* 👀 Fica de olho aqui que já já é sua vez.',
  'Você é o *próximo* 👀 Já já eu te chamo aqui.',
  'Sua vez tá chegando: você é o *próximo* 👀 Fica por aqui.',
];
const VARIANTES_PERTO = [
  (n) => `Tá chegando! Agora tem ${variantes.pessoas(n)} na sua frente 👀`,
  (n) => `Já tem só ${variantes.pessoas(n)} na sua frente 👀`,
  (n) => `Falta pouco! São ${variantes.pessoas(n)} na sua frente ⏳`,
];
const MSG_PROXIMO = VARIANTES_PROXIMO[0];

/** Qual aviso (se algum) cabe para quem ouviu `item.aFrenteAvisado` e agora tem `aFrente` na frente. */
function decidir(item, aFrente) {
  const ouviu = item.aFrenteAvisado;
  if (ouviu == null) return null;
  if (aFrente === 1 && ouviu > 1 && !item.avisoProximo) return 'proximo';
  if (aFrente >= 2 && aFrente <= 3 && ouviu > 3 && !item.avisoPerto) return 'perto';
  return null;
}

async function avisarUm(from, item, aFrente) {
  const qual = decidir(item, aFrente);
  if (!qual) return;
  // Marca ANTES de enviar: falha de envio não pode virar spam no tick seguinte.
  if (qual === 'proximo') {
    item.avisoProximo = true;
    item.avisoPerto = true; // pulou direto: o "perto" já não faz sentido
  } else {
    item.avisoPerto = true;
  }
  item.aFrenteAvisado = aFrente;
  persistAgora();
  try {
    await humaniza.enviar(
      from,
      qual === 'proximo'
        ? variantes.escolher('proximo', VARIANTES_PROXIMO, from)
        : variantes.escolher('perto', VARIANTES_PERTO, from, aFrente),
    );
  } catch (err) {
    console.error(`[ponte/avanco] aviso a ${from} falhou:`, err.message);
  }
}

async function avisar() {
  try {
    if (!cfg.ativa) return;
    if (limites.disjuntor().estado === 'aberto') return;
    const recepcao = require('./recepcao');

    const s = fila.situacao();
    const base = s.ativo ? 1 : 0;
    for (const x of s.aguardando) {
      const at = fila.porId(x.id);
      if (at) await avisarUm(at.from, at, base + x.posicao - 1);
    }
    for (const from of recepcao.esperandoVez()) {
      const item = recepcao.itemDaEspera(from);
      if (item) await avisarUm(from, item, recepcao.quantosNaFrente(from));
    }
  } catch (err) {
    console.error('[ponte/avanco] erro:', err.message);
  }
}

module.exports = { avisar, decidir, MSG_PROXIMO, VARIANTES_PROXIMO, VARIANTES_PERTO };
