'use strict';

/**
 * Testes do cliente da XPag (src/xpag.js).
 * Roda sem rede: o axios e substituido por um duble.
 *
 *   node teste-xpag.js
 *
 * O foco e o que da para errar com dinheiro no meio: mandar cobranca sem o
 * nosso identificador, tratar erro pela mensagem em vez do codigo, e acreditar
 * no corpo de um webhook que ninguem assinou.
 */

process.env.NERIX_API_KEY = 'teste';
process.env.PONTE_OPERADOR_NUMERO = '5541999999999';
process.env.PONTE_BRACO_KEY = 'teste';
process.env.DEEPSEEK_API_KEY = '';
process.env.PONTE_DATA_DIR = require('path').join(require('os').tmpdir(), 'phaze-teste-xpag');
process.env.XPAG_CLIENT_ID = 'xpagsandbox_00000000';
process.env.XPAG_CLIENT_SECRET = '202620262026202620262026';

const xpag = require('./src/xpag');

let falhas = 0;
const t = (nome, ok, extra = '') => {
  if (!ok) falhas++;
  console.log(`  ${ok ? 'ok  ' : 'FALHA'} | ${nome}${extra ? ` -> ${extra}` : ''}`);
};
const bloco = (nome) => console.log(`\n--- ${nome} ---`);

const chamadas = [];
function duble(resposta) {
  return {
    post: async (rota, corpo) => {
      chamadas.push({ metodo: 'POST', rota, corpo });
      if (resposta instanceof Error) throw resposta;
      return { data: resposta };
    },
    get: async (rota, opts) => {
      chamadas.push({ metodo: 'GET', rota, params: (opts || {}).params });
      if (resposta instanceof Error) throw resposta;
      return { data: resposta };
    },
  };
}

function erroDaApi(status, codigo, mensagem) {
  const e = new Error(mensagem);
  e.response = { status, data: { ok: false, error: mensagem, error_code: codigo }, headers: {} };
  return e;
}

(async () => {
  bloco('criar cobranca Pix');
  xpag._usarCliente(duble({ ok: true, copyPaste: '000201...', qr_img: 'data:image/png;base64,xx', transaction_id: 'pr_1', request_number: 'pr_1' }));
  chamadas.length = 0;

  let r = await xpag.cobrarPix({ valor: 149.9, externalId: 'PEDIDO-1', nome: 'Ana', documento: '123.456.789-00', descricao: 'Combo' });
  t('cobranca criada', r.ok === true, r.mensagem || '');
  t('devolve o copia e cola', r.copiaECola === '000201...');
  t('devolve o identificador da transacao', r.transacao === 'pr_1');
  const corpo = chamadas[0].corpo;
  t('bate na rota /cashin', chamadas[0].rota === '/cashin');
  t('moeda sempre BRL', corpo.currency === 'BRL');
  t('manda o nosso external_id', corpo.external_id === 'PEDIDO-1');
  t('limpa o documento', corpo.document === '12345678900');
  t('arredonda o valor em centavos', corpo.amount === 149.9);

  bloco('recusas antes de gastar chamada');
  chamadas.length = 0;
  r = await xpag.cobrarPix({ valor: 100 });
  t('sem external_id nao manda nada', r.ok === false && r.codigo === 'sem_external_id');
  r = await xpag.cobrarPix({ valor: 0, externalId: 'X' });
  t('valor zero e recusado', r.ok === false && r.codigo === 'invalid_amount');
  r = await xpag.cobrarPix({ valor: 'abc', externalId: 'X' });
  t('valor que nao e numero e recusado', r.ok === false && r.codigo === 'invalid_amount');
  r = await xpag.cobrarPix({ valor: -5, externalId: 'X' });
  t('valor negativo e recusado', r.ok === false && r.codigo === 'invalid_amount');
  t('nenhuma dessas foi para a rede', chamadas.length === 0, String(chamadas.length));

  bloco('erro da API vira codigo, nunca mensagem');
  xpag._usarCliente(duble(erroDaApi(422, 'insufficient_balance', 'Saldo insuficiente.')));
  r = await xpag.cobrarPix({ valor: 10, externalId: 'PEDIDO-2' });
  t('devolve o error_code estavel', r.ok === false && r.codigo === 'insufficient_balance');
  t('guarda a mensagem so para o log', r.mensagem === 'Saldo insuficiente.');
  t('guarda o status http', r.http === 422);

  xpag._usarCliente(duble(erroDaApi(401, 'invalid_credentials', 'Credenciais invalidas.')));
  r = await xpag.consultar({ transacao: 'pr_9' });
  t('credencial errada tambem vira codigo', r.ok === false && r.codigo === 'invalid_credentials');

  bloco('consultar para reconciliar');
  xpag._usarCliente(duble({ ok: true, type: 'cashin', status: 'confirmed', amount: 149.9, e2e: 'E123', external_id: 'PEDIDO-1' }));
  chamadas.length = 0;
  r = await xpag.consultar({ requisicao: 'pr_1' });
  t('consulta pelo request_number', r.ok === true && chamadas[0].params.request_number === 'pr_1');
  t('devolve o status real', r.status === 'confirmed');
  r = await xpag.consultar({ e2e: 'E123' });
  t('consulta pelo e2e', chamadas[1].params.e2e === 'E123');
  r = await xpag.consultar({});
  t('sem identificador nao consulta', r.ok === false && r.codigo === 'sem_identificador');

  bloco('ler o webhook');
  const dinamico = xpag.lerWebhook({ type: 'cashin', status: 'confirmed', amount: 123.45, fee: 1.23, currency: 'BRL', transaction_id: 'pr_7', e2e: 'E999', updated_at: '2026-10-03 12:00:00' });
  t('le cobranca dinamica', dinamico.tipo === 'cashin' && dinamico.status === 'confirmed' && dinamico.valor === 123.45);
  t('dinamica nao e estatica', dinamico.estatica === false);

  const estatico = xpag.lerWebhook({ type: 'cashin', origin: 'static', status: 'confirmed', amount: 100, external_id: 'PEDIDO-3', e2e: 'E111' });
  t('marca pagamento em chave fixa', estatico.estatica === true);
  t('traz o nosso external_id de volta', estatico.externalId === 'PEDIDO-3');

  const med = xpag.lerWebhook({ type: 'cashin', status: 'med', transaction_id: 'pr_7', med: { infraction_type: 'FRAUD' } });
  t('reconhece disputa', med.status === 'med' && med.disputa.infraction_type === 'FRAUD');

  const saqueFalho = xpag.lerWebhook({ type: 'cashout', status: 'failed', external_id: 'SAQUE-1', amount: 250 });
  t('le saque que falhou', saqueFalho.tipo === 'cashout' && saqueFalho.status === 'failed');

  t('corpo vazio nao quebra', xpag.lerWebhook(null).tipo === null);
  t('corpo sem nada conhecido nao quebra', xpag.lerWebhook({ lixo: 1 }).status === null);

  bloco('sandbox');
  xpag._usarCliente(duble({ ok: true }));
  chamadas.length = 0;
  r = await xpag.simular({ transacao: 'pr_1', desfecho: 'paid' });
  t('simula pagamento', r.ok === true && chamadas[0].rota === '/sandbox/simulate');
  r = await xpag.simular({ transacao: 'pr_1', desfecho: 'qualquer' });
  t('desfecho invalido e recusado', r.ok === false && r.codigo === 'desfecho_invalido');

  console.log(`\n${falhas ? `${falhas} FALHA(S)` : 'tudo certo'}\n`);
  process.exit(falhas ? 1 : 0);
})();
