'use strict';

/**
 * Dinheiro com a MOEDA junto.
 *
 * A loja vende em reais (Nerix) e em pesos mexicanos (XPag). Somar os dois num
 * numero so e o erro que este arquivo existe para impedir: 119 MXN nao sao
 * 119 BRL. Todo total do bot e um mapa { BRL: x, MXN: y } e sai daqui para o
 * texto.
 */

/**
 * TABELA DE MOEDAS. Moeda nova e uma linha aqui, nada mais.
 *   simbolo   como aparece antes do numero
 *   decimais  casas mostradas (CLP nao tem centavo; COP costuma sair sem)
 *   pais      nome para o aviso da equipe ("Venda paga (México)")
 * O numero sai sempre no formato dos avisos da equipe (1.234,50), que e
 * portugues, independente da moeda: a mensagem e lida por quem fala portugues.
 */
const MOEDAS = {
  BRL: { simbolo: 'R$', decimais: 2, pais: 'Brasil' },
  MXN: { simbolo: 'MX$', decimais: 2, pais: 'México' },
  COP: { simbolo: 'COL$', decimais: 0, pais: 'Colômbia' },
  CLP: { simbolo: 'CLP$', decimais: 0, pais: 'Chile' },
  ARS: { simbolo: 'AR$', decimais: 2, pais: 'Argentina' },
  BOB: { simbolo: 'Bs', decimais: 2, pais: 'Bolívia' },
  USD: { simbolo: 'US$', decimais: 2, pais: 'Equador' },
  VES: { simbolo: 'Bs.S', decimais: 2, pais: 'Venezuela' },
  USDT: { simbolo: 'USDT', decimais: 2, pais: 'USDT' },
  USDC: { simbolo: 'USDC', decimais: 2, pais: 'USDC' },
};

/** Normaliza o codigo da moeda. Sem informacao nenhuma, e BRL (Nerix). */
function codigo(moeda) {
  const m = String(moeda || '').trim().toUpperCase();
  return m || 'BRL';
}

const infoDe = (moeda) => MOEDAS[codigo(moeda)] || { simbolo: codigo(moeda), decimais: 2, pais: codigo(moeda) };

/** 1234.5 -> "1.234,50" (decimais da moeda; 0 em CLP/COP). */
function numero(n, moeda) {
  const dec = infoDe(moeda).decimais;
  const f = 10 ** dec;
  const v = Math.round((Number(n) || 0) * f) / f;
  const [int, frac] = Math.abs(v).toFixed(dec).split('.');
  return `${v < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${dec ? `,${frac}` : ''}`;
}

/** formatar(119, 'MXN') -> "MX$ 119,00" */
function formatar(valor, moeda) {
  return `${infoDe(moeda).simbolo} ${numero(valor, moeda)}`;
}

/** Soma por moeda: somar({}, 119, 'MXN'). */
function somar(totais, valor, moeda) {
  const c = codigo(moeda);
  totais[c] = Math.round(((totais[c] || 0) + (Number(valor) || 0)) * 100) / 100;
  return totais;
}

/**
 * { BRL: 1234, MXN: 119 } -> "R$ 1.234,00 + MX$ 119,00".
 * Vazio vira "R$ 0,00" (o resumo sempre mostrou o zero em reais).
 */
function formatarTotais(totais) {
  const chaves = Object.keys(totais || {}).filter((c) => totais[c]);
  if (!chaves.length) return formatar(0, 'BRL');
  chaves.sort((a, b) => (a === 'BRL' ? -1 : b === 'BRL' ? 1 : a.localeCompare(b)));
  return chaves.map((c) => formatar(totais[c], c)).join(' + ');
}

const paisDaMoeda = (moeda) => infoDe(moeda).pais;

module.exports = { MOEDAS, codigo, numero, formatar, somar, formatarTotais, paisDaMoeda };
