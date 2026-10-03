'use strict';

/**
 * Cliente da XPag — gateway de pagamento.
 * Docs: https://xpag.global/docs
 *
 * BASE PREPARATORIA. Este arquivo fala com a XPag e mais nada: nao cria
 * pedido, nao entrega produto, nao encosta no checkout da loja. Quem liga uma
 * coisa na outra e um passo seguinte, de proposito, porque o checkout atual ja
 * esta funcionando com outro gateway e nao pode parar.
 *
 * O CLIENT SECRET so existe aqui no servidor. No template da loja ele seria
 * publico, porque a Nerix serve os arquivos sem build.
 *
 * Autenticacao: cabecalhos X-Client-Id e X-Client-Secret (a doc tambem aceita
 * Basic Auth; os cabecalhos sao mais simples de ler no log sem vazar o valor).
 */

const axios = require('axios');
const config = require('./config');

const TIMEOUT_MS = 20000;

function configurado() {
  return !!(config.xpag.clientId && config.xpag.clientSecret);
}

let http = null;
function cliente() {
  if (!http) {
    http = axios.create({
      baseURL: config.xpag.url,
      timeout: TIMEOUT_MS,
      headers: {
        'X-Client-Id': config.xpag.clientId,
        'X-Client-Secret': config.xpag.clientSecret,
        'Content-Type': 'application/json',
      },
    });
  }
  return http;
}

/** Usado so pela suite, para trocar o cliente por um duble. */
function _usarCliente(novo) {
  http = novo;
}

/**
 * Normaliza a falha para um formato unico.
 *
 * A XPag devolve `error_code` estavel e `error` legivel, e manda avisando que
 * a mensagem muda por idioma. Entao a decisao SEMPRE sai do codigo, nunca do
 * texto. O texto fica so para o log e para o operador.
 */
function falha(e) {
  const r = e && e.response;
  const corpo = (r && r.data) || {};
  return {
    ok: false,
    http: (r && r.status) || 0,
    codigo: corpo.error_code || (r && r.headers && r.headers['x-app-error-code']) || 'sem_codigo',
    mensagem: corpo.error || e.message || 'falha ao falar com a XPag',
  };
}

/**
 * Cria uma cobranca Pix de valor fixo.
 *
 * `external_id` e NOSSO identificador e volta no webhook: e por ele que a
 * cobranca se liga ao pedido daqui. Mandar sempre, mesmo quando parecer
 * opcional, senao uma confirmacao chega sem dizer de quem e.
 */
async function cobrarPix({ valor, nome, documento, descricao, externalId, webhookUrl }) {
  if (!configurado()) return { ok: false, codigo: 'nao_configurado', mensagem: 'XPAG_CLIENT_ID e XPAG_CLIENT_SECRET nao estao no Environment' };

  const reais = Number(valor);
  if (!Number.isFinite(reais) || reais <= 0) {
    return { ok: false, codigo: 'invalid_amount', mensagem: 'valor invalido' };
  }
  if (!externalId) {
    return { ok: false, codigo: 'sem_external_id', mensagem: 'external_id e obrigatorio para casar a cobranca com o pedido' };
  }

  const corpo = {
    currency: 'BRL',
    amount: Math.round(reais * 100) / 100,
    external_id: String(externalId),
  };
  if (nome) corpo.name = String(nome).slice(0, 120);
  if (documento) corpo.document = String(documento).replace(/\D/g, '');
  if (descricao) corpo.description = String(descricao).slice(0, 140);

  const destino = webhookUrl || config.xpag.webhookUrl;
  if (destino) corpo.webhook_url = destino;

  try {
    const { data } = await cliente().post('/cashin', corpo);
    return {
      ok: true,
      copiaECola: data.copyPaste || null,
      qrImagem: data.qr_img || null,
      transacao: data.transaction_id || data.request_number || null,
      requisicao: data.request_number || null,
      sandbox: !!data.sandbox,
      bruto: data,
    };
  } catch (e) {
    return falha(e);
  }
}

/**
 * Estado real de uma transacao.
 *
 * O webhook e instantaneo e e por onde a confirmacao deve chegar. Esta consulta
 * existe para RECONCILIAR: webhook perdido, ou um webhook recebido que a gente
 * nao pode acreditar de cara (ver a nota na rota /webhooks/xpag do server.js).
 */
async function consultar({ transacao, requisicao, externalId, e2e }) {
  if (!configurado()) return { ok: false, codigo: 'nao_configurado', mensagem: 'XPag sem credenciais' };

  const params = {};
  if (requisicao) params.request_number = requisicao;
  else if (transacao) params.transaction_id = transacao;
  else if (e2e) params.e2e = e2e;
  else if (externalId) params.external_id = externalId;
  else return { ok: false, codigo: 'sem_identificador', mensagem: 'informe transacao, requisicao, e2e ou externalId' };

  try {
    const { data } = await cliente().get('/consult-transaction', { params });
    return {
      ok: true,
      tipo: data.type || null,
      status: data.status || null,
      valor: data.amount != null ? Number(data.amount) : null,
      externalId: data.external_id || null,
      e2e: data.e2e || null,
      pagamentos: Array.isArray(data.payments) ? data.payments : null,
      bruto: data,
    };
  } catch (e) {
    return falha(e);
  }
}

/**
 * So existe no sandbox: confirma, falha ou expira uma cobranca de teste e
 * dispara o webhook de verdade. E o que deixa testar os tres caminhos do
 * handler sem mover dinheiro.
 */
async function simular({ transacao, desfecho = 'paid' }) {
  if (!configurado()) return { ok: false, codigo: 'nao_configurado', mensagem: 'XPag sem credenciais' };
  if (['paid', 'failed', 'expired'].indexOf(desfecho) < 0) {
    return { ok: false, codigo: 'desfecho_invalido', mensagem: 'use paid, failed ou expired' };
  }
  try {
    const { data } = await cliente().post('/sandbox/simulate', { transaction_id: transacao, outcome: desfecho });
    return { ok: true, bruto: data };
  } catch (e) {
    return falha(e);
  }
}

/**
 * Le o corpo de um webhook da XPag para um formato unico.
 *
 * `origin: "static"` marca pagamento em chave fixa de valor aberto, onde o
 * mesmo external_id volta em pagamentos diferentes. Por isso a reconciliacao
 * e sempre pelo e2e, que e unico por pagamento.
 */
function lerWebhook(corpo) {
  const c = corpo || {};
  return {
    tipo: c.type || null,
    status: c.status || null,
    moeda: c.currency || null,
    valor: c.amount != null ? Number(c.amount) : null,
    taxa: c.fee != null ? Number(c.fee) : null,
    transacao: c.transaction_id || c.request_number || null,
    e2e: c.e2e || null,
    externalId: c.external_id || null,
    estatica: c.origin === 'static',
    disputa: c.status === 'med' ? c.med || {} : null,
    em: c.updated_at || null,
  };
}

module.exports = {
  configurado,
  cobrarPix,
  consultar,
  simular,
  lerWebhook,
  _usarCliente,
};
