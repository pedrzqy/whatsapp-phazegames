'use strict';

/**
 * Cliente da XPag — gateway de pagamento, com foco em MEXICO (MXN).
 * Docs: https://xpag.global/docs
 *
 * BASE PREPARATORIA. Este arquivo fala com a XPag e mais nada: nao cria
 * pedido, nao entrega produto, nao encosta no checkout da loja. Ligar uma
 * coisa na outra e um passo seguinte, de proposito, porque o checkout atual ja
 * esta funcionando com outro gateway e nao pode parar.
 *
 * O CLIENT SECRET so existe aqui no servidor. No template da loja ele seria
 * publico, porque a Nerix serve os arquivos sem build.
 *
 * Tres formas de receber em MXN, todas na MESMA rota /cashin:
 *
 *   speiPorValor   amount presente  -> CLABE daquele pagamento, vale 24h,
 *                                      valor exato (diferente e estornado)
 *   clabeDaVenda   sem amount       -> CLABE de valor aberto so daquela venda,
 *                                      mesmo external_id devolve a MESMA CLABE
 *   oxxo           method OXXO      -> voucher pago em dinheiro na loja,
 *                                      10 a 10.000 MXN, expira em 12 dias
 */

const axios = require('axios');
const config = require('./config');

const TIMEOUT_MS = 20000;

const OXXO_MIN = 10;
const OXXO_MAX = 10000;

/** XPAG_ENABLED=false desliga tudo mesmo com as credenciais no Environment. */
function ligado() {
  return config.xpag.enabled !== false;
}

function configurado() {
  return ligado() && !!(config.xpag.clientId && config.xpag.clientSecret);
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
 * A XPag devolve `error_code` estavel e `error` legivel, e avisa na propria
 * doc que a mensagem muda por idioma. Entao a decisao SEMPRE sai do codigo,
 * nunca do texto. O texto fica so para o log e para o operador.
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
 * Documento do pagador.
 *
 * NAO da para limpar isso com /\D/g. No Brasil o CPF e so digito, mas no
 * Mexico o documento e CURP ou RFC, que TEM LETRA (PEPJ800101HDFRRL09).
 * Tirar o que nao e numero transformaria o CURP em lixo e a cobranca seria
 * recusada com invalid_document, ou pior, criada com o pagador errado.
 */
function documentoDe(valor, moeda) {
  const bruto = String(valor == null ? '' : valor).trim();
  if (!bruto) return '';
  if (moeda === 'BRL') return bruto.replace(/\D/g, '');
  return bruto.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function baseDoCorpo({ moeda, externalId, nome, documento, descricao, webhookUrl, splits }) {
  const corpo = { currency: moeda, external_id: String(externalId) };
  if (nome) corpo.name = String(nome).slice(0, 120);
  const doc = documentoDe(documento, moeda);
  if (doc) corpo.document = doc;
  if (descricao) corpo.description = String(descricao).slice(0, 140);
  const destino = webhookUrl || config.xpag.webhookUrl;
  if (destino) corpo.webhook_url = destino;
  if (Array.isArray(splits) && splits.length) corpo.splits = splits;
  return corpo;
}

function semCredencial() {
  return {
    ok: false,
    codigo: 'nao_configurado',
    mensagem: ligado()
      ? 'XPAG_CLIENT_ID e XPAG_CLIENT_SECRET nao estao no Environment do servico'
      : 'XPAG_ENABLED=false: a integracao esta desligada',
  };
}

function valorValido(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * Resposta de uma cobranca MXN, no formato que a tela de pagamento precisa.
 *
 * `bank_name` e `beneficiary` vao junto porque a doc pede: o pagador ver o
 * banco e o nome do beneficiario e o que sustenta a confianca no SPEI, onde
 * ele digita uma CLABE de 18 digitos na mao.
 */
function leituraDaCobranca(data) {
  return {
    ok: true,
    moeda: data.currency || null,
    valor: data.amount != null ? Number(data.amount) : null,
    taxa: data.fee != null ? Number(data.fee) : null,
    clabe: data.clabe || null,
    referencia: data.reference || (data.payee_data && data.payee_data.reference) || null,
    codigoDeBarras: (data.payee_data && data.payee_data.barcode) || null,
    banco: data.bank_name || null,
    beneficiario: data.beneficiary || null,
    transacao: data.transaction_id || data.request_number || null,
    requisicao: data.request_number || null,
    status: data.status || null,
    aberta: !!data.open_value,
    estatica: !!data.static,
    sandbox: !!data.sandbox,
    bruto: data,
  };
}

/**
 * CLABE por valor: uma cobranca, 24 horas, valor exato.
 *
 * Valor diferente do pedido e ESTORNADO pela XPag, entao a tela precisa deixar
 * o numero muito claro para o pagador. Nao e como o Pix, em que o valor ja vai
 * embutido no codigo.
 */
async function speiPorValor({ valor, externalId, nome, documento, descricao, webhookUrl, splits }) {
  if (!configurado()) return semCredencial();
  if (!externalId) return { ok: false, codigo: 'sem_external_id', mensagem: 'external_id e obrigatorio para casar a cobranca com o pedido' };

  const amount = valorValido(valor);
  if (amount === null) return { ok: false, codigo: 'invalid_amount', mensagem: 'valor invalido' };

  const corpo = baseDoCorpo({ moeda: 'MXN', externalId, nome, documento, descricao, webhookUrl, splits });
  corpo.amount = amount;

  try {
    const { data } = await cliente().post('/cashin', corpo);
    return leituraDaCobranca(data);
  } catch (e) {
    return falha(e);
  }
}

/**
 * CLABE de valor aberto, uma por venda.
 *
 * O external_id e a chave do reuso: o mesmo devolve a MESMA CLABE, entao
 * repetir a chamada num retry nao cria cobranca duplicada. Mandar SEMPRE um
 * por venda; sem ele a XPag devolve a CLABE permanente da conta e a venda
 * deixa de ter dono.
 */
async function clabeDaVenda({ externalId, nome, documento, descricao, webhookUrl, splits }) {
  if (!configurado()) return semCredencial();
  if (!externalId) return { ok: false, codigo: 'sem_external_id', mensagem: 'sem external_id a XPag devolve a CLABE permanente da conta e a venda fica sem dono' };

  const corpo = baseDoCorpo({ moeda: 'MXN', externalId, nome, documento, descricao, webhookUrl, splits });

  try {
    const { data } = await cliente().post('/cashin', corpo);
    return leituraDaCobranca(data);
  } catch (e) {
    return falha(e);
  }
}

/**
 * Voucher OXXO, pago em dinheiro na loja.
 *
 * `generateCheckout: false` para a XPag devolver a referencia e o codigo de
 * barras crus, e a tela ser nossa. Com true ela hospeda uma pagina propria.
 *
 * Fica pendente ate o pagador ir a loja, o que pode levar dias. Isso e normal
 * aqui e nao e erro: quem decide e o webhook.
 */
async function oxxo({ valor, externalId, nome, email, descricao, webhookUrl, splits, paginaHospedada = false }) {
  if (!configurado()) return semCredencial();
  if (!externalId) return { ok: false, codigo: 'sem_external_id', mensagem: 'external_id e obrigatorio para casar o voucher com o pedido' };

  const amount = valorValido(valor);
  if (amount === null) return { ok: false, codigo: 'invalid_amount', mensagem: 'valor invalido' };
  if (amount < OXXO_MIN) return { ok: false, codigo: 'amount_below_min', mensagem: `OXXO aceita de ${OXXO_MIN} a ${OXXO_MAX} MXN` };
  if (amount > OXXO_MAX) return { ok: false, codigo: 'amount_above_limit', mensagem: `OXXO aceita de ${OXXO_MIN} a ${OXXO_MAX} MXN` };

  const corpo = baseDoCorpo({ moeda: 'MXN', externalId, nome, descricao, webhookUrl, splits });
  corpo.method = 'OXXO';
  corpo.amount = amount;
  corpo.generateCheckout = !!paginaHospedada;

  const pagador = {};
  if (nome) pagador.name = String(nome).slice(0, 120);
  if (email) pagador.email = String(email).trim();
  if (Object.keys(pagador).length) corpo.payerData = pagador;

  try {
    const { data } = await cliente().post('/cashin', corpo);
    return leituraDaCobranca(data);
  } catch (e) {
    return falha(e);
  }
}

/** Pix em BRL. Fica aqui porque a rota e a mesma, mas o uso hoje e o Mexico. */
async function pix({ valor, externalId, nome, documento, descricao, webhookUrl, splits }) {
  if (!configurado()) return semCredencial();
  if (!externalId) return { ok: false, codigo: 'sem_external_id', mensagem: 'external_id e obrigatorio' };

  const amount = valorValido(valor);
  if (amount === null) return { ok: false, codigo: 'invalid_amount', mensagem: 'valor invalido' };

  const corpo = baseDoCorpo({ moeda: 'BRL', externalId, nome, documento, descricao, webhookUrl, splits });
  corpo.amount = amount;

  try {
    const { data } = await cliente().post('/cashin', corpo);
    const r = leituraDaCobranca(data);
    r.copiaECola = data.copyPaste || null;
    r.qrImagem = data.qr_img || null;
    return r;
  } catch (e) {
    return falha(e);
  }
}

/** Primeiro valor preenchido (texto) entre varios caminhos possiveis. */
function primeiro(...vals) {
  for (const v of vals) if (v != null && String(v).trim() !== '') return String(v).trim();
  return '';
}

/**
 * Quem pagou, onde quer que a XPag ponha. A doc que temos NAO descreve o
 * pagador na resposta do /consult-transaction, entao a busca e por uma lista de
 * lugares plausiveis e tudo e opcional: sem dado, o campo fica vazio e a venda
 * segue sem telefone (o aviso vai so para a equipe, nunca se adivinha).
 */
function lerPagador(d) {
  const o = d || {};
  const p = o.payer || o.payer_data || o.payerData || o.customer || o.debtor || o.sender || {};
  return {
    nome: primeiro(p.name, p.full_name, p.nome, o.payer_name, o.name),
    documento: primeiro(p.document, p.tax_id, p.curp, p.rfc, o.payer_document, o.document),
    telefone: primeiro(p.phone, p.phone_number, p.mobile, p.whatsapp, o.payer_phone, o.phone),
    email: primeiro(p.email, o.payer_email, o.email),
  };
}

/** Uma transacao (ou um item de `payments`) no nosso formato. */
function lerTransacao(data) {
  const d = data || {};
  return {
    tipo: d.type || null,
    status: d.status || null,
    moeda: d.currency ? String(d.currency).toUpperCase() : null,
    valor: d.amount != null ? Number(d.amount) : null,
    taxa: d.fee != null ? Number(d.fee) : null,
    externalId: d.external_id || null,
    e2e: d.e2e || null,
    transacao: d.transaction_id || d.request_number || d.id || null,
    metodo: d.method || null,
    estatica: d.origin === 'static',
    pagador: lerPagador(d),
    em: d.updated_at || d.paid_at || d.created_at || null,
  };
}

/**
 * Estado real de uma transacao.
 *
 * O webhook e instantaneo e e por onde a confirmacao deve chegar. Esta consulta
 * existe para RECONCILIAR: webhook perdido, ou um webhook recebido em que nao
 * se pode acreditar de cara (ver a nota na rota /webhooks/xpag do server.js).
 *
 * Consultar por external_id numa CLABE de valor aberto devolve a LISTA dos
 * recebimentos daquela venda, porque ela aceita varios pagamentos.
 */
async function consultar({ transacao, requisicao, externalId, e2e, clabe, limite }) {
  if (!configurado()) return semCredencial();

  const params = {};
  if (requisicao) params.request_number = requisicao;
  else if (transacao) params.transaction_id = transacao;
  else if (e2e) params.e2e = e2e;
  else if (clabe) params.clabe = clabe;
  else if (externalId) params.external_id = externalId;
  else return { ok: false, codigo: 'sem_identificador', mensagem: 'informe transacao, requisicao, e2e, clabe ou externalId' };

  if (limite) params.limit = Math.min(Number(limite) || 20, 100);

  try {
    const { data } = await cliente().get('/consult-transaction', { params });
    return { ok: true, ...lerTransacao(data), pagamentos: Array.isArray(data.payments) ? data.payments.map(lerTransacao) : null, bruto: data };
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
  if (!configurado()) return semCredencial();
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
 * `origin: "static"` marca pagamento em CLABE de valor aberto, onde o mesmo
 * external_id volta em pagamentos diferentes. Por isso a reconciliacao e
 * sempre pelo e2e, que e unico por pagamento.
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
    metodo: c.method || null,
    e2e: c.e2e || null,
    externalId: c.external_id || null,
    estatica: c.origin === 'static',
    motivoDaFalha: c.fail_reason || null,
    disputa: c.status === 'med' ? c.med || {} : null,
    em: c.updated_at || null,
  };
}

module.exports = {
  OXXO_MIN,
  OXXO_MAX,
  configurado,
  ligado,
  lerPagador,
  lerTransacao,
  speiPorValor,
  clabeDaVenda,
  oxxo,
  pix,
  consultar,
  simular,
  lerWebhook,
  documentoDe,
  _usarCliente,
};
