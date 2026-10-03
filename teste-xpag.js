'use strict';

/**
 * Testes do cliente da XPag (src/xpag.js), com foco em MEXICO.
 * Roda sem rede: o axios e substituido por um duble.
 *
 *   node teste-xpag.js
 *
 * O foco e o que da para errar com dinheiro no meio: destruir o documento do
 * pagador mexicano, mandar cobranca sem o nosso identificador, tratar erro
 * pela mensagem em vez do codigo, e acreditar num webhook que ninguem assinou.
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
  bloco('documento do pagador');
  t('CPF brasileiro vira so digito', xpag.documentoDe('123.456.789-00', 'BRL') === '12345678900');
  t('CURP mexicano MANTEM as letras', xpag.documentoDe('PEPJ800101HDFRRL09', 'MXN') === 'PEPJ800101HDFRRL09');
  t('CURP com espaco e minuscula se arruma', xpag.documentoDe(' pepj800101hdfrrl09 ', 'MXN') === 'PEPJ800101HDFRRL09');
  t('RFC com hifen perde so a pontuacao', xpag.documentoDe('PEPJ-800101-AB1', 'MXN') === 'PEPJ800101AB1');
  t('documento vazio devolve vazio', xpag.documentoDe('', 'MXN') === '');

  bloco('CLABE por valor (SPEI dinamico)');
  xpag._usarCliente(duble({
    ok: true, reference: 'REF123456', clabe: '012345678901234567', amount: 500, fee: 5,
    currency: 'MXN', request_number: 'pr_1', transaction_id: 'pr_1', status: 'pending',
    bank_name: 'STP (Sistema de Transferencia y Pagos)', beneficiary: 'Zypher',
  }));
  chamadas.length = 0;

  let r = await xpag.speiPorValor({ valor: 500, externalId: 'PEDIDO-1', nome: 'Juan Perez', documento: 'PEPJ800101HDFRRL09', descricao: 'Pedido 123' });
  t('cobranca criada', r.ok === true, r.mensagem || '');
  t('devolve a CLABE', r.clabe === '012345678901234567');
  t('devolve a referencia', r.referencia === 'REF123456');
  t('devolve o banco para a tela', r.banco === 'STP (Sistema de Transferencia y Pagos)');
  t('devolve o beneficiario para a tela', r.beneficiario === 'Zypher');
  let corpo = chamadas[0].corpo;
  t('bate na rota /cashin', chamadas[0].rota === '/cashin');
  t('moeda MXN', corpo.currency === 'MXN');
  t('manda o amount, que e o que torna dinamica', corpo.amount === 500);
  t('o CURP chega inteiro na XPag', corpo.document === 'PEPJ800101HDFRRL09');
  t('manda o nosso external_id', corpo.external_id === 'PEDIDO-1');

  bloco('CLABE por venda (valor aberto)');
  xpag._usarCliente(duble({
    ok: true, static: true, open_value: true, currency: 'MXN', external_id: 'PEDIDO-2',
    clabe: '012345678901234999', transaction_id: 'spc123',
    bank_name: 'STP', beneficiary: 'Zypher',
  }));
  chamadas.length = 0;
  r = await xpag.clabeDaVenda({ externalId: 'PEDIDO-2', nome: 'Maria' });
  t('CLABE da venda criada', r.ok === true);
  t('marcada como aberta', r.aberta === true && r.estatica === true);
  corpo = chamadas[0].corpo;
  t('NAO manda amount, e isso que a torna aberta', corpo.amount === undefined);
  t('manda o external_id, que e a chave do reuso', corpo.external_id === 'PEDIDO-2');

  r = await xpag.clabeDaVenda({});
  t('sem external_id e recusado, senao a venda fica sem dono', r.ok === false && r.codigo === 'sem_external_id');

  bloco('OXXO');
  xpag._usarCliente(duble({
    ok: true, currency: 'MXN', amount: 250, fee: 5, method: 'OXXO',
    request_number: 'oxxo_1', transaction_id: 'oxxo_1', status: 'pending',
    transfer_type: 'REFERENCE',
    payee_data: { transferType: 'REFERENCE', reference: '8204240000119882', barcode: 'https://static.muwe.mx/abc.png' },
  }));
  chamadas.length = 0;
  r = await xpag.oxxo({ valor: 250, externalId: 'PEDIDO-3', nome: 'Luis Hernandez', email: 'luis@correo.com' });
  t('voucher criado', r.ok === true);
  t('devolve a referencia do caixa', r.referencia === '8204240000119882');
  t('devolve o codigo de barras para exibir', /muwe\.mx/.test(r.codigoDeBarras || ''));
  corpo = chamadas[0].corpo;
  t('manda method OXXO', corpo.method === 'OXXO');
  t('pede o voucher cru, nao a pagina deles', corpo.generateCheckout === false);
  t('leva os dados do pagador', corpo.payerData.name === 'Luis Hernandez' && corpo.payerData.email === 'luis@correo.com');

  chamadas.length = 0;
  r = await xpag.oxxo({ valor: 9, externalId: 'X' });
  t('abaixo de 10 MXN e recusado aqui', r.ok === false && r.codigo === 'amount_below_min');
  r = await xpag.oxxo({ valor: 10001, externalId: 'X' });
  t('acima de 10.000 MXN e recusado aqui', r.ok === false && r.codigo === 'amount_above_limit');
  t('nenhuma das duas foi para a rede', chamadas.length === 0, String(chamadas.length));
  r = await xpag.oxxo({ valor: 10, externalId: 'X' });
  t('o limite de baixo passa', r.ok === true || r.codigo !== 'amount_below_min');

  bloco('recusas antes de gastar chamada');
  chamadas.length = 0;
  r = await xpag.speiPorValor({ valor: 100 });
  t('sem external_id nao manda nada', r.ok === false && r.codigo === 'sem_external_id');
  r = await xpag.speiPorValor({ valor: 0, externalId: 'X' });
  t('valor zero e recusado', r.ok === false && r.codigo === 'invalid_amount');
  r = await xpag.speiPorValor({ valor: 'abc', externalId: 'X' });
  t('valor que nao e numero e recusado', r.ok === false && r.codigo === 'invalid_amount');
  r = await xpag.speiPorValor({ valor: -5, externalId: 'X' });
  t('valor negativo e recusado', r.ok === false && r.codigo === 'invalid_amount');
  t('nenhuma dessas foi para a rede', chamadas.length === 0, String(chamadas.length));

  bloco('erro da API vira codigo, nunca mensagem');
  xpag._usarCliente(duble(erroDaApi(422, 'insufficient_balance', 'Saldo insuficiente.')));
  r = await xpag.speiPorValor({ valor: 10, externalId: 'PEDIDO-4' });
  t('devolve o error_code estavel', r.ok === false && r.codigo === 'insufficient_balance');
  t('guarda a mensagem so para o log', r.mensagem === 'Saldo insuficiente.');
  t('guarda o status http', r.http === 422);

  xpag._usarCliente(duble(erroDaApi(401, 'invalid_credentials', 'Credenciais invalidas.')));
  r = await xpag.consultar({ transacao: 'pr_9' });
  t('credencial errada tambem vira codigo', r.ok === false && r.codigo === 'invalid_credentials');

  bloco('consultar para reconciliar');
  xpag._usarCliente(duble({ ok: true, type: 'cashin', status: 'confirmed', amount: 500, e2e: 'E123', external_id: 'PEDIDO-1' }));
  chamadas.length = 0;
  r = await xpag.consultar({ requisicao: 'pr_1' });
  t('consulta pelo request_number', r.ok === true && chamadas[0].params.request_number === 'pr_1');
  t('devolve o status real', r.status === 'confirmed');
  await xpag.consultar({ e2e: 'E123' });
  t('consulta pelo e2e', chamadas[1].params.e2e === 'E123');
  await xpag.consultar({ clabe: '012345678901234567' });
  t('consulta pela CLABE', chamadas[2].params.clabe === '012345678901234567');
  r = await xpag.consultar({});
  t('sem identificador nao consulta', r.ok === false && r.codigo === 'sem_identificador');

  xpag._usarCliente(duble({ ok: true, type: 'cashin', count: 2, payments: [{ e2e: 'E1' }, { e2e: 'E2' }] }));
  r = await xpag.consultar({ externalId: 'PEDIDO-2' });
  t('CLABE aberta devolve a lista de pagamentos', Array.isArray(r.pagamentos) && r.pagamentos.length === 2);

  bloco('ler o webhook');
  const dinamico = xpag.lerWebhook({ type: 'cashin', status: 'confirmed', amount: 500, fee: 5, currency: 'MXN', transaction_id: 'pr_7', e2e: 'E999' });
  t('le cobranca dinamica', dinamico.tipo === 'cashin' && dinamico.status === 'confirmed' && dinamico.valor === 500);
  t('dinamica nao e estatica', dinamico.estatica === false);

  const estatico = xpag.lerWebhook({ type: 'cashin', origin: 'static', status: 'confirmed', amount: 100, currency: 'MXN', external_id: 'PEDIDO-2', e2e: 'E111' });
  t('marca pagamento em CLABE aberta', estatico.estatica === true);
  t('traz o nosso external_id de volta', estatico.externalId === 'PEDIDO-2');

  const med = xpag.lerWebhook({ type: 'cashin', status: 'med', transaction_id: 'pr_7', med: { infraction_type: 'FRAUD' } });
  t('reconhece disputa', med.status === 'med' && med.disputa.infraction_type === 'FRAUD');

  const saqueFalho = xpag.lerWebhook({ type: 'cashout', status: 'failed', external_id: 'SAQUE-1', amount: 250, fail_reason: 'Chave invalida.' });
  t('le saque que falhou', saqueFalho.tipo === 'cashout' && saqueFalho.status === 'failed');
  t('guarda o motivo da falha', saqueFalho.motivoDaFalha === 'Chave invalida.');

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
