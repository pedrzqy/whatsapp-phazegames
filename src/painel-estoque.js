'use strict';

/**
 * Cliente do PAINEL DE ESTOQUE (serviço próprio no Square Cloud).
 *
 * As contas de jogo saíram da Nerix e moram no banco do painel. A Nerix vende
 * com estoque "infinito" e entrega um texto vazio, então o pedido pago chega
 * aqui com `product_key` vazio, e quem sabe qual conta é de quem passou a ser
 * o painel.
 *
 * O painel é a fonte da verdade da RESERVA: pedir a entrega do mesmo pedido
 * duas vezes devolve as mesmas contas (trava por pedido no banco). Quem cuida
 * de não MANDAR duas vezes é o `marcar` do vendas.js, como em toda entrega.
 *
 * Desligado quando PAINEL_URL ou PAINEL_BOT_CHAVE estão vazios: aí o bot
 * volta ao comportamento antigo (conta sem chave = entrega na mão).
 */

const axios = require('axios');

const URL_PAINEL = (process.env.PAINEL_URL || '').trim().replace(/\/+$/, '');
const CHAVE = (process.env.PAINEL_BOT_CHAVE || '').trim();

const http = axios.create({
  baseURL: URL_PAINEL || 'http://painel-desligado.invalid',
  // 25 s e não 15: a entrega busca o pedido na Nerix antes de reservar, e a
  // Nerix às vezes segura a resposta por causa do limite de chamadas.
  timeout: 25000,
  headers: { 'x-bot-chave': CHAVE, 'Content-Type': 'application/json' },
});

const ligado = () => Boolean(URL_PAINEL && CHAVE);

/**
 * Reserva (ou relê) as contas do pedido.
 * Devolve { nada } quando o pedido não tem jogo com conta no painel, ou
 * { itens, falta, mensagem, enviada } quando tem.
 */
async function entregar(codigo) {
  const { data } = await http.post(`/bot/pedidos/${encodeURIComponent(codigo)}/entregar`);
  return {
    nada: Boolean(data?.nada),
    ja: Boolean(data?.ja),
    enviada: Boolean(data?.enviada),
    itens: Array.isArray(data?.itens) ? data.itens : [],
    falta: Array.isArray(data?.falta) ? data.falta : [],
    mensagem: String(data?.mensagem || ''),
  };
}

/**
 * O que falta mandar de um pedido que já tem entrega no painel. Usado quando
 * o atendente digita no painel a conta de um jogo que estava sem estoque.
 */
async function aEnviar(codigo) {
  const { data } = await http.post(`/bot/pedidos/${encodeURIComponent(codigo)}/a-enviar`);
  return {
    nada: Boolean(data?.nada),
    itens: Array.isArray(data?.itens) ? data.itens : [],
    falta: Array.isArray(data?.falta) ? data.falta : [],
    mensagem: String(data?.mensagem || ''),
  };
}

/**
 * Conta ao painel se a mensagem saiu, para aparecer na tela dos atendentes.
 * `ids` são os itens que foram nesta mensagem: o painel marca só eles, e o
 * próximo pedido de envio do mesmo pedido não repete nenhum.
 */
async function enviado(codigo, ok, erro, ids) {
  try {
    await http.post(`/bot/pedidos/${encodeURIComponent(codigo)}/enviado`, { ok: Boolean(ok), erro: erro ? String(erro).slice(0, 200) : undefined, ids: ids || [] });
  } catch (err) {
    // Só a etiqueta da tela fica errada; a entrega em si já aconteceu ou já
    // virou alerta. Não vale derrubar nada por isso.
    console.warn(`[painel] não consegui marcar o envio de ${codigo}: ${err.response?.status || err.message}`);
  }
}

/** As contas que o painel entregou nestes pedidos (para o #meulogin). */
async function acessos(codigos) {
  if (!ligado() || !codigos.length) return [];
  const { data } = await http.post('/bot/acessos', { pedidos: codigos.slice(0, 20) });
  return Array.isArray(data?.acessos) ? data.acessos : [];
}

/** A chave que o painel manda quando pede um envio (mesma PAINEL_BOT_CHAVE). */
const chave = () => CHAVE;

module.exports = { ligado, entregar, aEnviar, enviado, acessos, chave };
