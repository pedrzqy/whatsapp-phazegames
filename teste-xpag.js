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
require('fs').rmSync(process.env.PONTE_DATA_DIR, { recursive: true, force: true });
process.env.PONTE_HUMANIZA = 'false';
process.env.PONTE_ATIVA = 'true';
process.env.EVOLUTION_API_KEY = 'teste';
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

  // ═══════════════════════════════════════════════════════════════
  // Venda confirmada: webhook -> consulta -> registro (xpagVendas.js)
  // ═══════════════════════════════════════════════════════════════
  const vendas = require('./src/vendas');
  const resumo = require('./src/resumo');
  const moeda = require('./src/moeda');
  const nerix = require('./src/nerix');
  const sender = require('./src/sender');
  const operador = require('./src/ponte/operador');

  bloco('moeda: tabela generica');
  t('BRL com milhar', moeda.formatar(1234, 'BRL') === 'R$ 1.234,00', moeda.formatar(1234, 'BRL'));
  t('MXN', moeda.formatar(119, 'MXN') === 'MX$ 119,00');
  t('CLP sem centavo', moeda.formatar(25000.4, 'CLP') === 'CLP 25.000');
  t('COP sem centavo', moeda.formatar(80000, 'COP') === 'COP 80.000');
  t('moeda desconhecida mostra o codigo', moeda.formatar(5, 'XYZ') === 'XYZ 5,00');
  t('totais separados por moeda', moeda.formatarTotais({ BRL: 1234, MXN: 119 }) === 'R$ 1.234,00 + MX$ 119,00');
  t('totais vazios = R$ 0,00', moeda.formatarTotais({}) === 'R$ 0,00');

  // Duble da XPag: devolve o estado "real" que o teste definir, por parametro.
  const E2E = 'MBAN01002610210063633699';
  let estadoReal = {};
  const consultas = [];
  xpag._usarCliente({
    get: async (rota, { params }) => {
      consultas.push(params);
      const chave = params.e2e || params.transaction_id || params.request_number || params.external_id;
      const d = estadoReal[chave] || Object.values(estadoReal).find((x) => x.e2e === chave || x.transaction_id === chave);
      if (!d) { throw erroDaApi(404, 'transaction_not_found', 'nao achei'); }
      return { data: d };
    },
    post: async () => ({ data: {} }),
  });
  const confirmadoMXN = {
    ok: true, type: 'cashin', status: 'confirmed', amount: 119, currency: 'MXN', method: 'SPEI',
    e2e: E2E, transaction_id: 'pr_aaa', external_id: 'PED-77',
    payer: { name: 'Maria Lopez', document: 'LOPM800101MDFRRL09', phone: '+52 1 627 178 2434' },
    updated_at: '2026-10-21 10:00:00',
  };

  const enviadas = [];
  sender.send = async (para, texto) => { enviadas.push({ para, texto }); return true; };
  nerix.getOrder = async () => { throw new Error('404'); };
  const GRUPO = '120363@g.us';
  vendas.definirGrupoVendas(GRUPO);

  const http = require('http');
  const { app } = require('./src/server');
  const srv = http.createServer(app);
  await new Promise((ok) => srv.listen(0, ok));
  const porta = srv.address().port;
  const postar = async (corpo, secret = '') => {
    const r = await fetch(`http://127.0.0.1:${porta}/webhooks/xpag${secret ? `?secret=${secret}` : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
    });
    await new Promise((ok) => setTimeout(ok, 150));
    return r.status;
  };
  const corpoWebhook = { type: 'cashin', status: 'confirmed', amount: 119, currency: 'MXN', method: 'SPEI', e2e: E2E, transaction_id: 'pr_aaa', external_id: 'PED-77' };
  const config = require('./src/config');
  config.webhook.xpagSecret = 'segredo';
  const nXpag = () => Object.values(vendas._dados().pedidos).filter((x) => x.origem === 'xpag').length;

  bloco('webhook: confirmado registra uma vez');
  estadoReal = { [E2E]: confirmadoMXN, pr_aaa: confirmadoMXN };
  t('sem o segredo da URL: 401 e nada registrado', (await postar(corpoWebhook)) === 401 && enviadas.length === 0);
  t('com segredo: 200', (await postar(corpoWebhook, 'segredo')) === 200);
  const reg = Object.values(vendas._dados().pedidos).filter((x) => x.origem === 'xpag');
  t('uma venda registrada', reg.length === 1, String(reg.length));
  t('moeda MXN, valor numerico, origem xpag', reg[0]?.moeda === 'MXN' && reg[0]?.valor === 119 && reg[0]?.origem === 'xpag');
  t('documento fica mascarado', reg[0]?.documento === '****RL09' && !JSON.stringify(vendas._dados()).includes('LOPM800101'), JSON.stringify(reg[0]));
  const aviso = enviadas.find((e) => e.para === GRUPO);
  t('aviso no grupo da equipe em MXN', !!aviso && /Venda paga \(México\)/.test(aviso.texto) && /MX\$ 119,00/.test(aviso.texto), aviso && aviso.texto.split('\n')[0]);
  t('aviso diz entregar manualmente', /Entregar manualmente/.test(aviso?.texto || ''));
  t('aviso nao traz o documento inteiro', !/LOPM800101MDFRRL09/.test(aviso?.texto || ''));
  const cli = enviadas.find((e) => e.para === '526271782434');
  t('cliente avisado no telefone do pagador (52 + 10 digitos)', !!cli && /pago confirmado/i.test(cli.texto) && /\$119 MXN/.test(cli.texto) && !/pagamento/i.test(cli.texto), cli && cli.texto.split('\n')[0]);

  bloco('webhook: repeticao e duplicata');
  const antes = enviadas.length;
  await postar(corpoWebhook, 'segredo');
  await postar({ ...corpoWebhook, transaction_id: 'outro' }, 'segredo');
  t('repeticao nao conta em dobro', nXpag() === 1);
  t('repeticao nao avisa de novo', enviadas.length === antes);

  bloco('webhook: corpo falso com estado real diferente');
  estadoReal.E999FALSO = { ...confirmadoMXN, e2e: 'E999FALSO', transaction_id: 'pr_falso', status: 'pending' };
  const antes2 = enviadas.length;
  await postar({ ...corpoWebhook, e2e: 'E999FALSO', transaction_id: 'pr_falso', external_id: 'X' }, 'segredo');
  t('pending real: ignorado', nXpag() === 1 && enviadas.length === antes2);
  await postar({ ...corpoWebhook, e2e: 'NAOEXISTE', transaction_id: 'pr_nada' }, 'segredo');
  t('transacao inexistente: ignorada', nXpag() === 1);

  bloco('CLABE aberta: dois pagamentos, mesmo external_id/transaction_id');
  estadoReal.EST1 = { ok: true, type: 'cashin', status: 'confirmed', amount: 100, currency: 'MXN', e2e: 'EST1', transaction_id: 'PED-9', external_id: 'PED-9', origin: 'static' };
  estadoReal.EST2 = { ...estadoReal.EST1, e2e: 'EST2', amount: 50 };
  const est = { type: 'cashin', origin: 'static', status: 'confirmed', currency: 'MXN', external_id: 'PED-9', transaction_id: 'PED-9' };
  await postar({ ...est, amount: 100, e2e: 'EST1' }, 'segredo');
  await postar({ ...est, amount: 50, e2e: 'EST2' }, 'segredo');
  await postar({ ...est, amount: 50, e2e: 'EST2' }, 'segredo');
  t('cada e2e e uma venda (2 novas, repeticao ignorada)', nXpag() === 3, String(nXpag()));
  t('consulta de CLABE aberta foi pelo e2e', consultas.some((p) => p.e2e === 'EST1'));

  bloco('sem telefone: so a equipe');
  estadoReal.SEMTEL = { ok: true, type: 'cashin', status: 'confirmed', amount: 80, currency: 'MXN', e2e: 'SEMTEL', transaction_id: 'pr_st' };
  enviadas.length = 0;
  await postar({ ...corpoWebhook, e2e: 'SEMTEL', transaction_id: 'pr_st', external_id: undefined, amount: 80 }, 'segredo');
  t('so o grupo recebe', enviadas.length === 1 && enviadas[0].para === GRUPO, String(enviadas.length));
  t('aviso manda falar com o cliente na mao', /Sem telefone vinculado/.test(enviadas[0]?.texto || ''));

  bloco('vinculo por pedido da loja so quando o valor bate');
  nerix.getOrder = async () => ({ data: { order_number: 'PED-55', status: 'pending', payment_status: 'pending', total: 119, customer_name: 'Ana', customer_phone: '5216271112222', items: [{ product_name: 'Jogo X', quantity: 1 }] } });
  estadoReal.LIGA = { ok: true, type: 'cashin', status: 'confirmed', amount: 119, currency: 'MXN', e2e: 'LIGA', transaction_id: 'pr_l', external_id: 'PED-55' };
  estadoReal.NAOLIGA = { ok: true, type: 'cashin', status: 'confirmed', amount: 300, currency: 'MXN', e2e: 'NAOLIGA', transaction_id: 'pr_nl', external_id: 'PED-55' };
  enviadas.length = 0;
  await postar({ ...corpoWebhook, e2e: 'LIGA', transaction_id: 'pr_l', external_id: 'PED-55' }, 'segredo');
  t('valor bate: avisa o cliente do pedido', enviadas.some((e) => e.para === '526271112222') && enviadas.some((e) => /Jogo X/.test(e.texto)));
  enviadas.length = 0;
  await postar({ ...corpoWebhook, e2e: 'NAOLIGA', transaction_id: 'pr_nl', external_id: 'PED-55', amount: 300 }, 'segredo');
  t('valor diferente: nao vincula, so equipe', enviadas.length === 1 && enviadas[0].para === GRUPO, String(enviadas.length));
  nerix.getOrder = async () => { throw new Error('404'); };

  bloco('resumo e #vendas: moedas separadas');
  vendas._dados().pedidos['N-1'] = { visto: Date.now(), notificado: Date.now(), valor: 1234, moeda: 'BRL' };
  const txt = (await resumo.montar()).texto;
  t('resumo soma por moeda', /R\$ 1\.234,00 \+ MX\$ /.test(txt), (txt.match(/Vendas:.*/) || [])[0]);
  nerix.listOrders = async () => ({ data: [] });
  const vend = await operador.executar('#vendas', '5541999999999');
  t('#vendas mostra as duas moedas', /Faturado: \*MX\$ /.test(vend) && /pela XPag/.test(vend), vend.split('\n').slice(0, 4).join(' | '));
  t('#vendas avisa entrega na mao', /entrega na mão/.test(vend));
  t('#ajuda lista o #xpag', /#xpag/.test(operador.AJUDA));
  t('#xpag e reconhecido como comando', operador.ehComando('5541999999999', '#xpag hoje'));

  bloco('#xpag: consulta e registrar (HTTP mockado)');
  const nova = 'MBAN01002610210099999999';
  estadoReal[nova] = { ...confirmadoMXN, e2e: nova, transaction_id: 'pr_back', external_id: undefined, payer: { name: 'Pedro Cliente', document: 'PECP800101HDFRRL09' }, updated_at: '2026-10-21 09:00:00' };
  enviadas.length = 0;
  let out = await operador.executar(`#xpag ${nova}`, '5541999999999');
  t('consulta mostra status, valor, pagador e ja registrada: nao', /confirmed/.test(out) && /MX\$ 119,00/.test(out) && /Pedro Cliente/.test(out) && /registrada no bot: \*não\*/.test(out), out.replace(/\n/g, ' | '));
  t('consulta nao mostra documento inteiro', !/PECP800101HDFRRL09/.test(out));
  t('consulta sozinha nao registra', !vendas.acharVendaExterna([nova]) && enviadas.length === 0);
  out = await operador.executar(`#xpag ${nova} registrar`, '5541999999999');
  t('registrar lanca a venda', /Registrada como venda/.test(out) && !!vendas.acharVendaExterna([nova]), out.replace(/\n/g, ' | '));
  t('registrar avisou a equipe', enviadas.filter((e) => e.para === GRUPO).length === 1);
  const regB = vendas._dados().pedidos['xpag:' + nova];
  t('data do backfill vem da API (21/10)', !!regB && new Date(regB.notificado - 3 * 3600 * 1000).toISOString().startsWith('2026-10-21'));
  enviadas.length = 0;
  out = await operador.executar(`#xpag ${nova} registrar`, '5541999999999');
  t('registrar de novo e idempotente', /já estava registrada/i.test(out) && enviadas.length === 0);
  t('so uma venda desse codigo', Object.keys(vendas._dados().pedidos).filter((k) => k.includes(nova)).length === 1);
  estadoReal.PEND = { ok: true, type: 'cashin', status: 'pending', amount: 10, currency: 'MXN', e2e: 'PEND' };
  out = await operador.executar('#xpag PEND registrar', '5541999999999');
  t('pendente nao registra', /Não registrei/.test(out) && !vendas.acharVendaExterna(['PEND']));
  out = await operador.executar('#xpag NAOEXISTE123', '5541999999999');
  t('codigo desconhecido responde sem quebrar', /Não achei/.test(out));
  out = await operador.executar('#xpag hoje', '5541999999999');
  t('#xpag hoje lista o que o bot registrou', /Vendas XPag de hoje|Nenhuma venda XPag/.test(out));

  bloco('repasse do phaze-xpag (evento: pago)');
  const repasse = { evento: 'pago', pedido: 'MX-REP-1', transacao: 'pr_rep1', e2e: 'REP1E2E', valor: 119, moeda: 'MXN',
    cliente: { nome: 'Ana Torres', email: 'ana@exemplo.mx', telefone: '+52 627 178 2434' }, itens: [{ nome: 'Gift Card Xbox', quantidade: 2 }, { nome: 'Free Fire 100' , quantidade: 1 }] };
  estadoReal.REP1E2E = { ok: true, type: 'cashin', status: 'confirmed', amount: 119, currency: 'MXN', e2e: 'REP1E2E', transaction_id: 'pr_rep1', external_id: 'MX-REP-1' };
  enviadas.length = 0;
  const n0 = nXpag();
  t('repasse sem o segredo: 401', (await postar(repasse)) === 401 && nXpag() === n0);
  t('repasse com segredo: 200', (await postar(repasse, 'segredo')) === 200);
  t('repasse conferido registra 1 venda', nXpag() === n0 + 1);
  const avRep = enviadas.find((e) => e.para === GRUPO);
  t('equipe: valor MXN, itens e nome', !!avRep && /Venda paga \(México\)/.test(avRep.texto) && /MX\$ 119,00/.test(avRep.texto) && /Gift Card Xbox \(2x\)/.test(avRep.texto) && /Ana Torres/.test(avRep.texto), (avRep?.texto || '').replace(/\n/g, ' | '));
  t('equipe: continua mandando entregar manualmente', /Entregar manualmente/.test(avRep?.texto || ''));
  const cliRep = enviadas.find((e) => e.para === '526271782434');
  t('cliente avisado pelo telefone do repasse', !!cliRep && /Ana/.test(cliRep.texto) && /\$119 MXN/.test(cliRep.texto) && /Recibimos tu pago/.test(cliRep.texto));
  const antesRep = enviadas.length;
  await postar(repasse, 'segredo');
  t('repasse repetido nao conta nem avisa de novo', nXpag() === n0 + 1 && enviadas.length === antesRep);

  // Mesma chave do webhook cru: cru primeiro, repasse depois (e vice-versa).
  estadoReal.CRUREP = { ok: true, type: 'cashin', status: 'confirmed', amount: 50, currency: 'MXN', e2e: 'CRUREP', transaction_id: 'pr_cr', external_id: 'MX-CR' };
  await postar({ ...corpoWebhook, e2e: 'CRUREP', transaction_id: 'pr_cr', external_id: 'MX-CR', amount: 50 }, 'segredo');
  const n1 = nXpag();
  await postar({ evento: 'pago', pedido: 'MX-CR', transacao: 'pr_cr', e2e: 'CRUREP', valor: 50, moeda: 'MXN' }, 'segredo');
  t('cru + repasse do mesmo e2e: uma venda so', nXpag() === n1);

  // XPag diz pendente: repasse mentindo nao registra.
  estadoReal.REPFALSO = { ok: true, type: 'cashin', status: 'pending', amount: 10, currency: 'MXN', e2e: 'REPFALSO', transaction_id: 'pr_rf' };
  const n2 = nXpag();
  await postar({ evento: 'pago', pedido: 'X', transacao: 'pr_rf', e2e: 'REPFALSO', valor: 10, moeda: 'MXN' }, 'segredo');
  t('com credenciais, repasse nao confirmado pela XPag e ignorado', nXpag() === n2);
  // e2e desconhecido, mas a transacao existe: cai na consulta por transacao.
  estadoReal.PRTX = { ok: true, type: 'cashin', status: 'confirmed', amount: 70, currency: 'MXN', e2e: 'E2EREAL', transaction_id: 'pr_tx' };
  await postar({ evento: 'pago', pedido: 'MX-TX', transacao: 'pr_tx', e2e: 'E2EDIFERENTE', valor: 70, moeda: 'MXN' }, 'segredo');
  t('e2e nao achado: confere pela transacao', nXpag() === n2 + 1);

  // Sem credenciais: confia no repasse (com o segredo) por padrao.
  const credId = config.xpag.clientId, credSec = config.xpag.clientSecret;
  config.xpag.clientId = ''; config.xpag.clientSecret = '';
  t('sem credenciais: xpag.configurado() false', xpag.configurado() === false);
  enviadas.length = 0;
  const n3 = nXpag();
  const consultasAntes = consultas.length;
  const semCred = { evento: 'pago', pedido: 'MX-SC-1', transacao: 'pr_sc', e2e: 'SC1E2E', valor: 200, moeda: 'MXN', nome: 'Luis', telefone: '6271112233', itens: [{ name: 'PSN 10 USD', qty: 1 }] };
  t('sem credenciais e sem segredo: 401', (await postar(semCred)) === 401 && nXpag() === n3);
  await postar(semCred, 'segredo');
  t('sem credenciais: aceita o repasse (confiarRepasse) sem consultar', nXpag() === n3 + 1 && consultas.length === consultasAntes);
  t('sem credenciais: equipe e cliente avisados', enviadas.some((e) => e.para === GRUPO && /MX\$ 200,00/.test(e.texto) && /PSN 10 USD/.test(e.texto) && /Luis/.test(e.texto)) && enviadas.some((e) => e.para === '526271112233'));
  await postar(semCred, 'segredo');
  t('sem credenciais: repeticao idempotente', nXpag() === n3 + 1);
  await postar({ ...semCred, e2e: undefined, transacao: 'so_tx' }, 'segredo');
  t('sem credenciais e sem e2e: nao registra', nXpag() === n3 + 1);
  await postar({ ...semCred, e2e: 'SC2E2E', moeda: '', valor: 5 }, 'segredo');
  t('sem moeda: nao registra', nXpag() === n3 + 1);
  config.xpag.confiarRepasse = false;
  await postar({ ...semCred, e2e: 'SC3E2E' }, 'segredo');
  t('XPAG_CONFIAR_REPASSE=false: sem credenciais nao registra', nXpag() === n3 + 1);
  config.xpag.confiarRepasse = true;
  config.xpag.clientId = credId; config.xpag.clientSecret = credSec;

  bloco('repasse: disputa e saque_falhou');
  enviadas.length = 0;
  const n4 = nXpag();
  await postar({ evento: 'disputa', pedido: 'MX-D1', transacao: 'pr_d1', detalhes: {} }, 'segredo');
  t('disputa alerta a equipe e nao registra venda', enviadas.length === 1 && enviadas[0].para === GRUPO && /Disputa/.test(enviadas[0].texto) && /MX-D1/.test(enviadas[0].texto) && nXpag() === n4);
  enviadas.length = 0;
  await postar({ evento: 'saque_falhou', pedido: 'SQ-1', motivo: 'conta invalida' }, 'segredo');
  t('saque_falhou alerta a equipe', enviadas.length === 1 && /Saque falhou/.test(enviadas[0].texto) && /conta invalida/.test(enviadas[0].texto));
  enviadas.length = 0;
  t('evento desconhecido: 200 e nada acontece', (await postar({ evento: 'xyz' }, 'segredo')) === 200 && enviadas.length === 0 && nXpag() === n4);

  bloco('SEGURANCA: repasse sem XPAG_WEBHOOK_SECRET e recusado');
  {
    const secretAntes = config.webhook.xpagSecret;
    const credId2 = config.xpag.clientId, credSec2 = config.xpag.clientSecret;
    // Pior caso de verdade: sem segredo, sem credenciais, confiarRepasse ligado.
    config.webhook.xpagSecret = '';
    config.xpag.clientId = ''; config.xpag.clientSecret = '';
    config.xpag.confiarRepasse = true;
    enviadas.length = 0;
    const nA = nXpag();
    const falso = { evento: 'pago', pedido: 'FALSO-1', transacao: 'pr_falso', e2e: 'FALSOE2E', valor: 99999, moeda: 'MXN', nome: 'Golpista', telefone: '6271112233' };
    t('repasse falso sem segredo configurado: 401', (await postar(falso)) === 401);
    t('repasse falso mesmo mandando ?secret=qualquer: 401', (await postar(falso, 'qualquer')) === 401);
    t('nenhuma venda registrada e ninguem avisado', nXpag() === nA && enviadas.length === 0);
    const direto = await require('./src/xpagVendas').processarRepasse(falso);
    t('processarRepasse tambem recusa (defesa em profundidade)', direto.ok === false && /XPAG_WEBHOOK_SECRET/.test(direto.motivo) && nXpag() === nA);
    t('alerta de disputa falsa tambem e recusado', (await postar({ evento: 'disputa', pedido: 'X' })) === 401 && enviadas.length === 0);
    // Com o segredo configurado, volta a funcionar normalmente.
    config.webhook.xpagSecret = 'segredo';
    t('com o segredo configurado e certo: aceito', (await postar({ ...falso, e2e: 'FALSOE2E-OK', valor: 10, pedido: 'OK-1' }, 'segredo')) === 200 && nXpag() === nA + 1);
    config.webhook.xpagSecret = secretAntes;
    config.xpag.clientId = credId2; config.xpag.clientSecret = credSec2;
  }

  bloco('Colombia e Chile: aviso da equipe e status completed');
  t('COP: formatar', moeda.formatar(45900, 'COP') === 'COP 45.900', moeda.formatar(45900, 'COP'));
  t('CLP: formatar', moeda.formatar(43790, 'CLP') === 'CLP 43.790', moeda.formatar(43790, 'CLP'));
  t('pais da moeda', moeda.paisDaMoeda('COP') === 'Colômbia' && moeda.paisDaMoeda('CLP') === 'Chile');
  t('totais misturam moedas sem somar', moeda.formatarTotais({ BRL: 100, COP: 45900, CLP: 43790 }) === 'R$ 100,00 + CLP 43.790 + COP 45.900', moeda.formatarTotais({ BRL: 100, COP: 45900, CLP: 43790 }));
  {
    const sv = require('./src/xpagVendas');
    t('statusPago: completed vale so em COP/CLP', sv.statusPago('completed', 'COP') && sv.statusPago('completed', 'CLP') && !sv.statusPago('completed', 'MXN') && !sv.statusPago('completed', null) && sv.statusPago('confirmed', 'MXN'));

    estadoReal.COPE2E = { ok: true, type: 'cashin', status: 'confirmed', amount: 45900, currency: 'COP', method: 'NEQUI_QR', e2e: 'COPE2E', transaction_id: 'pr_cop', external_id: 'CO-1-ABC' };
    enviadas.length = 0;
    const nB = nXpag();
    await postar({ evento: 'pago', pedido: 'CO-1-ABC', transacao: 'pr_cop', e2e: 'COPE2E', valor: 45900, moeda: 'COP', cliente: { nome: 'Ana Gomez', email: 'ana@correo.co', telefone: '+57 300 123 4567' }, itens: [{ nome: 'Gift Card Xbox', quantidade: 1 }] }, 'segredo');
    const avCop = enviadas.find((e) => e.para === GRUPO);
    t('COP: equipe recebe "Venda paga (Colômbia) — COP 45.900"', nXpag() === nB + 1 && !!avCop && avCop.texto.split('\n')[0].indexOf('Venda paga (Colômbia)* — COP 45.900') >= 0, (avCop?.texto || '').split('\n')[0]);
    t('COP: itens e nome no aviso', /Gift Card Xbox/.test(avCop?.texto || '') && /Ana Gomez/.test(avCop?.texto || ''));
    t('COP: venda guardada em COP, valor inteiro', Object.values(vendas._dados().pedidos).some((x) => x.origem === 'xpag' && x.moeda === 'COP' && x.valor === 45900));

    // Chile: a consulta devolve "completed" (o bot precisa aceitar).
    estadoReal.CLPE2E = { ok: true, type: 'cashin', status: 'completed', amount: 43790, currency: 'CLP', method: 'BANK_TRANSFER', e2e: 'CLPE2E', transaction_id: 'CLPE2E', external_id: 'CL-1-XYZ' };
    enviadas.length = 0;
    const nC = nXpag();
    await postar({ evento: 'pago', pedido: 'CL-1-XYZ', transacao: 'CLPE2E', e2e: 'CLPE2E', valor: 43790, moeda: 'CLP', cliente: { nome: 'Juan Perez', email: 'juan@correo.cl' }, itens: [{ nome: 'PSN 20 USD', quantidade: 1 }] }, 'segredo');
    const avClp = enviadas.find((e) => e.para === GRUPO);
    t('CLP completed: equipe recebe "Venda paga (Chile) — CLP 43.790"', nXpag() === nC + 1 && !!avClp && avClp.texto.split('\n')[0].indexOf('Venda paga (Chile)* — CLP 43.790') >= 0, (avClp?.texto || '').split('\n')[0]);

    // MXN com "completed" na consulta continua recusado.
    estadoReal.MXCOMP = { ok: true, type: 'cashin', status: 'completed', amount: 50, currency: 'MXN', e2e: 'MXCOMP', transaction_id: 'pr_mxc' };
    const nD = nXpag();
    await postar({ evento: 'pago', pedido: 'MX-C', transacao: 'pr_mxc', e2e: 'MXCOMP', valor: 50, moeda: 'MXN' }, 'segredo');
    t('MXN completed na consulta: nao registra (so confirmed)', nXpag() === nD);

    // Webhook cru da XPag em CLP com status completed.
    estadoReal.CLRAW = { ok: true, type: 'cashin', status: 'completed', amount: 5000, currency: 'CLP', method: 'CARD', e2e: 'CLRAW', transaction_id: 'CLRAW', external_id: 'CL-RAW' };
    const nE = nXpag();
    await postar({ type: 'cashin', status: 'completed', amount: 5000, currency: 'CLP', method: 'CARD', e2e: 'CLRAW', transaction_id: 'CLRAW', external_id: 'CL-RAW' }, 'segredo');
    t('webhook cru CLP completed: registra 1 venda', nXpag() === nE + 1);
  }

  // ═══════════════════════════════════════════════════════════════
  // Lembretes de pagamento das cobrancas da XPag (criada -> lembretes)
  // ═══════════════════════════════════════════════════════════════
  {
    const lem = require('./src/xpagLembretes');
    const { idiomaDoTelefone } = require('./src/idioma');
    const telefones = require('./src/telefone');
    const chavesMod = require('./src/chaves');
    const store = require('./src/store');
    const HORA = 3600 * 1000;
    const MINU = 60 * 1000;
    const T0 = Date.UTC(2026, 9, 22, 17, 0); // 11h no Mexico, 12h na Colombia, 14h no Chile
    const dados = () => lem._dados().pedidos;
    const iso = (ms) => new Date(ms).toISOString();
    const para = (num) => enviadas.filter((e) => e.para === num);

    const base = (extra = {}) => ({
      evento: 'criada', pedido: 'MX-L-1', valor: 109, moeda: 'MXN', pais: 'MX', metodo: 'spei',
      criadaEm: iso(T0), expiraEm: iso(T0 + 24 * HORA),
      cliente: { nome: 'ana gomez', email: 'a@b.mx', telefone: '55 1234 5678' },
      itens: [{ nome: 'Celeste', quantidade: 1 }],
      pagamento: { clabe: '012345678901234567', banco: 'STP', beneficiario: 'Zypher', linkPedido: 'https://phazegames.com/mexico?pedido=MX-L-1' },
      ...extra,
    });
    const NUM_MX = '525512345678';

    bloco('idioma pelo telefone');
    t('52, 57 e 56 em espanhol', idiomaDoTelefone('525512345678') === 'es' && idiomaDoTelefone('573001234567') === 'es' && idiomaDoTelefone('56912345678') === 'es');
    t('outros hispanicos (54, 591, 593, 595, 598, 51, 58, 506, 507, 502, 503, 504, 505)', ['5491155551234', '59171234567', '593991234567', '595981123456', '59899123456', '51987654321', '584121234567', '50688887777', '50761234567', '50255551234', '50370001234', '50499887766', '50588887777'].every((n) => idiomaDoTelefone(n) === 'es'));
    t('55 em portugues; vazio e desconhecido em portugues', idiomaDoTelefone('5511912345678') === 'pt' && idiomaDoTelefone('') === 'pt' && idiomaDoTelefone(null) === 'pt' && idiomaDoTelefone('12125551234') === 'pt' && idiomaDoTelefone('18095551234') === 'pt');
    t('aceita jid', idiomaDoTelefone('525512345678@s.whatsapp.net') === 'es');
    t('telefone da Colombia sem DDI (pista CO)', telefones.paraWhatsApp('300 123 4567', 'CO') === '573001234567' && telefones.paraWhatsApp('+57 300 123 4567', 'CO') === '573001234567');
    t('telefone do Chile sem DDI (pista CL)', telefones.paraWhatsApp('9 1234 5678', 'CL') === '56912345678' && telefones.paraWhatsApp('+56 9 1234 5678', 'CL') === '56912345678');
    t('colombiano nao vira numero mexicano; lixo e recusado', telefones.paraWhatsApp('300 123 4567', 'COP') !== '523001234567' && telefones.paraWhatsApp('12345', 'CO') === null && telefones.paraWhatsApp('5512345678', 'MX') === '525512345678');

    bloco('lembretes: SPEI do Mexico (criada -> 3 lembretes em espanhol)');
    lem._limpar();
    enviadas.length = 0;
    let rc = lem.registrarCriada(base(), T0);
    t('criada agenda: ok, nova, com telefone', rc.ok && rc.novo === true && rc.semTelefone === false);
    t('3 passos (30min, 6h, 4h antes de vencer)', dados()['MX-L-1'].passos.length === 3 && dados()['MX-L-1'].numero === NUM_MX);
    rc = lem.registrarCriada(base(), T0 + MINU);
    t('criada repetida: ignorada, nada duplicado', rc.ok && rc.novo === false && Object.keys(dados()).length === 1 && dados()['MX-L-1'].passos.length === 3);
    t('10 min depois: ainda nao sai nada', (await lem.tick(T0 + 10 * MINU)) === 0 && enviadas.length === 0);
    t('31 min depois: sai o 1o lembrete', (await lem.tick(T0 + 31 * MINU)) === 1 && para(NUM_MX).length === 1);
    let m1 = para(NUM_MX)[0]?.texto || '';
    t('1o lembrete em espanhol com CLABE, banco, beneficiario, monto exato e link', /^¡Hola, Ana!/.test(m1) && m1.includes('`012345678901234567`') && m1.includes('Banco: STP') && m1.includes('Beneficiario: Zypher') && m1.includes('Monto exacto: *$109 MXN* (pesos mexicanos)') && m1.includes('https://phazegames.com/mexico?pedido=MX-L-1'), m1.split('\n')[0]);
    t('nao fala em portugues nem cita fornecedor', !/pagamento|aguardando|Oi,/.test(m1) && !/taobao|fornecedor|proveedor/i.test(m1));
    t('um minuto depois: nada novo (nao repete)', (await lem.tick(T0 + 32 * MINU)) === 0 && (await lem.tick(T0 + 3 * HORA)) === 0);
    t('6h30: sai o 2o', (await lem.tick(T0 + 6.5 * HORA)) === 1 && para(NUM_MX).length === 2);
    t('20h30 (7h30 no Mexico, fora da janela): espera', (await lem.tick(T0 + 14.5 * HORA)) === 0 && (await lem.tick(T0 + 20.5 * HORA)) === 0);
    t('22h (9h no Mexico): sai o ultimo, "vence hoy"', (await lem.tick(T0 + 22 * HORA)) === 1 && /vence hoy|(venc)/.test(para(NUM_MX)[2]?.texto || '') && para(NUM_MX).length === 3, (para(NUM_MX)[2]?.texto || '').split('\n')[0]);
    t('no maximo 3: depois nada mais', (await lem.tick(T0 + 23 * HORA)) === 0 && (await lem.tick(T0 + 30 * HORA)) === 0 && para(NUM_MX).length === 3);
    t('as 3 mensagens sao diferentes entre si', new Set(para(NUM_MX).map((e) => e.texto.split('\n')[0])).size === 3);

    bloco('lembretes: persistencia no volume');
    lem._recarregar();
    t('estado relido do disco', dados()['MX-L-1'] && dados()['MX-L-1'].passos.every((s) => s.feito) && require('fs').existsSync(require('path').join(process.env.PONTE_DATA_DIR, 'xpag-pendentes.json')));
    t('depois de recarregar nao repete', (await lem.tick(T0 + 22.2 * HORA)) === 0);

    bloco('lembretes: pago cancela (repasse real)');
    lem._limpar();
    enviadas.length = 0;
    lem.registrarCriada(base({ pedido: 'MX-L-2', cliente: { nome: 'Luis', telefone: '55 8765 4321' }, pagamento: { clabe: '012', linkPedido: 'https://phazegames.com/mexico?pedido=MX-L-2' } }), T0);
    estadoReal.LEMB2 = { ok: true, type: 'cashin', status: 'confirmed', amount: 109, currency: 'MXN', method: 'SPEI', e2e: 'LEMB2', transaction_id: 'pr_l2', external_id: 'MX-L-2' };
    await postar({ evento: 'pago', pedido: 'MX-L-2', transacao: 'pr_l2', e2e: 'LEMB2', valor: 109, moeda: 'MXN', cliente: { nome: 'Luis', telefone: '55 8765 4321' } }, 'segredo');
    t('pago encerra o calendario', dados()['MX-L-2'].status === 'paga');
    const antesPago = enviadas.length;
    t('depois do pago nenhum lembrete sai', (await lem.tick(T0 + 31 * MINU)) === 0 && (await lem.tick(T0 + 7 * HORA)) === 0 && enviadas.length === antesPago);
    const confLuis = para('525587654321')[0];
    t('o aviso de pagamento confirmado foi em espanhol', !!confLuis && /pago confirmado/.test(confLuis.texto) && /\$109 MXN/.test(confLuis.texto), confLuis && confLuis.texto.split('\n')[0]);

    bloco('lembretes: pago ANTES da criada (evento fora de ordem)');
    lem._limpar();
    enviadas.length = 0;
    lem.encerrar('MX-L-9', 'paga');
    rc = lem.registrarCriada(base({ pedido: 'MX-L-9' }), T0);
    t('criada atrasada de pedido ja pago nao agenda', rc.ok && rc.novo === false && (await lem.tick(T0 + 31 * MINU)) === 0 && enviadas.length === 0);

    bloco('lembretes: pago conferido na XPag antes de cutucar');
    lem._limpar();
    enviadas.length = 0;
    lem.registrarCriada(base({ pedido: 'MX-L-8' }), T0);
    estadoReal['MX-L-8'] = { ok: true, type: 'cashin', status: 'confirmed', amount: 109, currency: 'MXN', e2e: 'LEMB8', transaction_id: 'pr_l8', external_id: 'MX-L-8' };
    t('a XPag diz pago (webhook perdido): nao cobra e encerra', (await lem.tick(T0 + 31 * MINU)) === 0 && dados()['MX-L-8'].status === 'paga' && enviadas.length === 0);
    delete estadoReal['MX-L-8'];

    bloco('lembretes: expirada para os lembretes (repasse real) e o relogio tambem');
    lem._limpar();
    enviadas.length = 0;
    lem.registrarCriada(base({ pedido: 'MX-L-3', metodo: 'oxxo', expiraEm: iso(T0 + 12 * 24 * HORA), cliente: { nome: 'Rosa', telefone: '55 1111 2222' }, pagamento: { referenciaOxxo: '9876543210', linkPedido: 'https://phazegames.com/mexico?pedido=MX-L-3' } }), T0);
    lem.registrarCriada(base({ pedido: 'MX-L-3B', metodo: 'oxxo', expiraEm: iso(T0 + 12 * 24 * HORA), cliente: { nome: 'Rita', telefone: '55 3333 4444' }, pagamento: { referenciaOxxo: '1234567890', urlVoucher: 'https://voucher.test/x', linkPedido: 'https://phazegames.com/mexico?pedido=MX-L-3B' } }), T0);
    t('expirada com segredo: 200', (await postar({ evento: 'expirada', pedido: 'MX-L-3' }, 'segredo')) === 200 && dados()['MX-L-3'].expirada === true);
    t('expirada sem segredo: 401 e nada muda', (await postar({ evento: 'expirada', pedido: 'MX-L-3B' })) === 401 && !dados()['MX-L-3B'].expirada);
    t('OXXO: 2h30 depois so a cobranca viva recebe lembrete', (await lem.tick(T0 + 2.5 * HORA)) === 1 && para('525533334444').length === 1 && para('525511112222').length === 0);
    const ox = para('525533334444')[0]?.texto || '';
    t('OXXO: referencia, monto, ficha e link do pedido', ox.includes('`1234567890`') && ox.includes('OXXO') && ox.includes('$109 MXN') && ox.includes('https://voucher.test/x') && ox.includes('pedido=MX-L-3B'));
    t('OXXO: 2o lembrete so no dia seguinte (24h)', (await lem.tick(T0 + 8 * HORA)) === 0 && (await lem.tick(T0 + 25 * HORA)) === 1);
    t('OXXO: 3o no dia anterior ao vencimento (dia 11), vence "mañana"', (await lem.tick(T0 + 11 * 24 * HORA + 2 * HORA)) === 1 && /vence mañana|\(vence mañana\)/.test(para('525533334444')[2]?.texto || ''), (para('525533334444')[2]?.texto || '').split('\n')[0]);

    lem._limpar();
    enviadas.length = 0;
    lem.registrarCriada(base({ pedido: 'MX-L-4' }), T0);
    t('vencida pelo relogio (sem aviso do backend): nada sai', (await lem.tick(T0 + 25 * HORA)) === 0 && enviadas.length === 0);

    bloco('lembretes: Colombia (Nequi 45 min) em espanhol');
    lem._limpar();
    enviadas.length = 0;
    lem.registrarCriada(base({ pedido: 'CO-L-1', valor: 39900, moeda: 'COP', pais: 'CO', metodo: 'nequi_qr', expiraEm: iso(T0 + 45 * MINU), cliente: { nome: 'Ana Gomez', telefone: '300 123 4567' }, pagamento: { checkoutUrl: 'https://pay.xpag.test/co', qr: 'https://qr.xpag.test/co.png', linkPedido: 'https://phazegames.com/mexico?pedido=CO-L-1' } }), T0);
    t('telefone sem DDI vira 57 + 10 (pista da moeda)', dados()['CO-L-1'].numero === '573001234567');
    t('5 min depois nada; 21 min depois o aviso rapido (antes de vencer)', (await lem.tick(T0 + 5 * MINU)) === 0 && (await lem.tick(T0 + 21 * MINU)) === 1);
    const co1 = para('573001234567')[0]?.texto || '';
    t('COP: valor com ponto de milhar, peso colombiano, link e pedido', /^¡Hola, Ana!/.test(co1) && co1.includes('$39.900 COP') && co1.includes('pesos colombianos') && co1.includes('https://pay.xpag.test/co') && co1.includes('pedido=CO-L-1') && /Nequi/.test(co1), co1.split('\n').slice(0, 4).join(' | '));
    t('vence em minutos', /minutos|pronto|breve/.test(co1.split('\n')[0]));
    t('depois do aviso rapido e antes de vencer: nada', (await lem.tick(T0 + 40 * MINU)) === 0);
    t('11 min depois de vencer: oferece gerar um codigo novo, com o link da loja', (await lem.tick(T0 + 56 * MINU)) === 1 && /venci/.test(para('573001234567')[1]?.texto || '') && para('573001234567')[1].texto.includes('https://phazegames.com'), (para('573001234567')[1]?.texto || '').split('\n')[0]);
    t('so isso: nada mais depois', (await lem.tick(T0 + 5 * HORA)) === 0 && para('573001234567').length === 2);

    lem._limpar();
    enviadas.length = 0;
    lem.registrarCriada(base({ pedido: 'CO-L-2', valor: 39900, moeda: 'COP', pais: 'CO', metodo: 'breb', expiraEm: undefined, cliente: { nome: 'Pedro', telefone: '+57 311 222 3333' }, pagamento: { chaveBreb: '@llave123', checkoutUrl: 'https://pay.xpag.test/co2' } }), T0);
    t('Bre-B sem expiraEm no evento: assume 15 min; aviso aos 7 min', (await lem.tick(T0 + 4 * MINU)) === 0 && (await lem.tick(T0 + 8 * MINU)) === 1 && para('573112223333')[0].texto.includes('@llave123') && /Bre-B/.test(para('573112223333')[0].texto));
    await postar({ evento: 'expirada', pedido: 'CO-L-2' }, 'segredo');
    t('Bre-B vencida: oferece codigo novo uma vez', (await lem.tick(T0 + 30 * MINU)) === 1 && /venci/.test(para('573112223333')[1].texto));

    bloco('lembretes: Chile (checkout) em espanhol');
    lem._limpar();
    enviadas.length = 0;
    lem.registrarCriada(base({ pedido: 'CL-L-1', valor: 6090, moeda: 'CLP', pais: 'CL', metodo: 'bank_transfer', expiraEm: undefined, cliente: { nome: 'Juan', telefone: '9 1234 5678' }, pagamento: { checkoutUrl: 'https://pay.xpag.test/cl', linkPedido: 'https://phazegames.com/mexico?pedido=CL-L-1' } }), T0);
    t('telefone chileno vira 56 + 9', dados()['CL-L-1'].numero === '56912345678');
    t('CLP: 31 min depois sai o lembrete', (await lem.tick(T0 + 31 * MINU)) === 1);
    const cl1 = para('56912345678')[0]?.texto || '';
    t('CLP: $6.090 CLP, pesos chilenos, link de pagamento e pedido', cl1.includes('$6.090 CLP') && cl1.includes('pesos chilenos') && cl1.includes('https://pay.xpag.test/cl') && cl1.includes('pedido=CL-L-1'));
    t('CLP: 3o lembrete sem inventar vencimento', (await lem.tick(T0 + 4.5 * HORA)) === 1 && (await lem.tick(T0 + 20.5 * HORA)) === 1 && !/vence (hoy|mañana)/.test(para('56912345678')[2]?.texto || ''));

    bloco('lembretes: portugues para telefone +55');
    lem._limpar();
    enviadas.length = 0;
    lem.registrarCriada(base({ pedido: 'MX-L-5', cliente: { nome: 'Carla', telefone: '+55 11 91234-5678' } }), T0);
    t('+55 explicito vira 5511912345678', dados()['MX-L-5'].numero === '5511912345678');
    await lem.tick(T0 + 31 * MINU);
    const pt = para('5511912345678')[0]?.texto || '';
    t('texto em portugues, valor em R$/MX$ e CLABE', /^Oi, Carla!/.test(pt) && pt.includes('Valor exato: *MX$ 109,00*') && pt.includes('Favorecido: Zypher') && pt.includes('`012345678901234567`') && !/Hola|Monto/.test(pt), pt.split('\n')[0]);

    bloco('lembretes: sem telefone nao ha mensagem ao cliente');
    lem._limpar();
    enviadas.length = 0;
    rc = lem.registrarCriada(base({ pedido: 'MX-L-6', cliente: { nome: 'Sem Fone', telefone: '' } }), T0);
    const rc2 = lem.registrarCriada(base({ pedido: 'MX-L-7', cliente: { nome: 'Fone Ruim', telefone: '123' } }), T0);
    t('sem telefone: registrada, sem telefone', rc.ok && rc.semTelefone === true && rc2.semTelefone === true && dados()['MX-L-6'].numero === null);
    t('nenhum lembrete e nada para a equipe', (await lem.tick(T0 + 31 * MINU)) === 0 && (await lem.tick(T0 + 7 * HORA)) === 0 && enviadas.length === 0);
    t('conta como pendente sem telefone no resumo', lem.pendentes(T0 + HORA).total === 2 && lem.pendentes(T0 + HORA).semTelefone === 2);
    t('resumo do dia mostra "Pendentes XPag"', /Pendentes XPag: \*2\* \(2 sem telefone\)/.test((await resumo.montar({ agora: T0 + HORA })).texto));

    bloco('lembretes: horario civil do cliente');
    lem._limpar();
    enviadas.length = 0;
    const T1 = Date.UTC(2026, 9, 22, 8, 0); // 2h no Mexico
    lem.registrarCriada(base({ pedido: 'MX-L-10', criadaEm: iso(T1), expiraEm: iso(T1 + 24 * HORA) }), T1);
    t('de madrugada no Mexico nao sai', (await lem.tick(T1 + 31 * MINU)) === 0 && (await lem.tick(T1 + 3 * HORA)) === 0);
    t('9h no Mexico sai so UMA (o 2o, que ja valia), sem rajada do 1o', (await lem.tick(T1 + 7 * HORA)) === 1 && para(NUM_MX).length === 1 && dados()['MX-L-10'].passos[0].pulado);

    bloco('lembretes: uma mensagem por pessoa');
    lem._limpar();
    enviadas.length = 0;
    lem.registrarCriada(base({ pedido: 'MX-L-11' }), T0);
    lem.registrarCriada(base({ pedido: 'MX-L-12', valor: 200, criadaEm: iso(T0 + 5 * MINU) }), T0 + 5 * MINU);
    t('a cobranca nova substitui a antiga da mesma pessoa', dados()['MX-L-11'].status === 'substituida' && dados()['MX-L-12'].status === 'aberta');
    await lem.tick(T0 + 40 * MINU);
    t('so sai uma mensagem, da mais recente', para(NUM_MX).length === 1 && para(NUM_MX)[0].texto.includes('$200 MXN'));

    bloco('lembretes: conversa assumida e chave do atendimento');
    lem._limpar();
    enviadas.length = 0;
    lem.registrarCriada(base({ pedido: 'MX-L-13' }), T0);
    store.saveContact(NUM_MX, { paused: true });
    t('contato com atendente (paused): nao cutuca', (await lem.tick(T0 + 31 * MINU)) === 0);
    store.saveContact(NUM_MX, { paused: false });
    t('liberado, o lembrete sai dentro do prazo do passo', (await lem.tick(T0 + HORA)) === 1);
    chavesMod.definir('atendimento', false);
    t('atendimento desligado (#admin 1): o 2o lembrete nao sai', (await lem.tick(T0 + 6.5 * HORA)) === 0 && dados()['MX-L-13'].passos[1].pulado === 'atendimento_desligado');
    chavesMod.definir('atendimento', null);
    lem._limpar();
    enviadas.length = 0;
    lem.registrarCriada(base({ pedido: 'MX-L-14' }), T0);
    chavesMod.definir('atendimento', false);
    t('atendimento desligado: o 1o lembrete (fluxo de pagamento, como o do Pix) continua', (await lem.tick(T0 + 31 * MINU)) === 1);
    chavesMod.definir('atendimento', null);

    bloco('lembretes: chave XPAG_LEMBRETES');
    lem._limpar();
    enviadas.length = 0;
    lem.registrarCriada(base({ pedido: 'MX-L-15' }), T0);
    process.env.XPAG_LEMBRETES = 'false';
    t('XPAG_LEMBRETES=false: nada sai', (await lem.tick(T0 + 31 * MINU)) === 0);
    delete process.env.XPAG_LEMBRETES;

    bloco('lembretes: o endpoint (segredo obrigatorio, repeticao, moeda)');
    lem._limpar();
    const secretAntes = config.webhook.xpagSecret;
    const cHttp = { evento: 'criada', pedido: 'HTTP-1', valor: 109, moeda: 'MXN', pais: 'MX', metodo: 'spei', cliente: { nome: 'Teste', telefone: '55 9999 8888' }, pagamento: { clabe: '012', linkPedido: 'https://phazegames.com/mexico?pedido=HTTP-1' } };
    t('criada sem o segredo na URL: 401 e nao agenda', (await postar(cHttp)) === 401 && !dados()['HTTP-1']);
    t('criada com segredo errado: 401', (await postar(cHttp, 'errado')) === 401 && !dados()['HTTP-1']);
    config.webhook.xpagSecret = '';
    t('segredo NAO configurado no bot: criada recusada (401)', (await postar(cHttp)) === 401 && !dados()['HTTP-1']);
    config.webhook.xpagSecret = secretAntes;
    t('processarRepasse direto sem segredo tambem recusa', await (async () => { config.webhook.xpagSecret = ''; const r = await require('./src/xpagVendas').processarRepasse(cHttp); config.webhook.xpagSecret = secretAntes; return r.ok === false && !dados()['HTTP-1']; })());
    t('criada com o segredo: 200 e agenda', (await postar(cHttp, 'segredo')) === 200 && dados()['HTTP-1'] && dados()['HTTP-1'].numero === '525599998888');
    const n0Http = Object.keys(dados()).length;
    await postar({ ...cHttp, valor: 999 }, 'segredo');
    t('criada repetida via HTTP: nao duplica nem muda', Object.keys(dados()).length === n0Http && dados()['HTTP-1'].valor === 109);
    await postar({ ...cHttp, pedido: 'HTTP-2', moeda: 'BRL' }, 'segredo');
    t('moeda sem lembrete (BRL) e ignorada', !dados()['HTTP-2']);
    await postar({ ...cHttp, pedido: 'HTTP-3', valor: 0 }, 'segredo');
    t('valor invalido e ignorado', !dados()['HTTP-3']);
    await postar({ ...cHttp, pedido: 'HTTP-4', pagamento: { checkoutUrl: 'javascript:alert(1)', linkPedido: 'ftp://x', clabe: '012' } }, 'segredo');
    t('link que nao e http(s) e descartado', dados()['HTTP-4'] && !dados()['HTTP-4'].pagamento.checkoutUrl && !dados()['HTTP-4'].pagamento.linkPedido);
    await postar({ ...cHttp, pedido: 'HTTP-5', cliente: { nome: 'Doc', telefone: '55 7777 6666', documento: 'PEPJ800101HDFRRL09' } }, 'segredo');
    t('documento (CURP/RFC) nunca e guardado', !JSON.stringify(lem._dados()).includes('PEPJ800101'));

    bloco('lembretes: aviso de pago em espanhol (Colombia sem DDI no telefone)');
    enviadas.length = 0;
    estadoReal.COPLEMB = { ok: true, type: 'cashin', status: 'confirmed', amount: 45900, currency: 'COP', method: 'NEQUI_QR', e2e: 'COPLEMB', transaction_id: 'pr_coplemb', external_id: 'CO-L-PAGO' };
    await postar({ evento: 'pago', pedido: 'CO-L-PAGO', transacao: 'pr_coplemb', e2e: 'COPLEMB', valor: 45900, moeda: 'COP', cliente: { nome: 'Ana Gomez', telefone: '300 123 4567' } }, 'segredo');
    const confCo = para('573001234567')[0];
    t('COP: confirmacao vai para o 57 certo, em espanhol, em pesos', !!confCo && /pago confirmado/.test(confCo.texto) && confCo.texto.includes('$45.900 COP') && !/pagamento/.test(confCo.texto), confCo && confCo.texto.split('\n').join(' | '));
    estadoReal.CLLEMB = { ok: true, type: 'cashin', status: 'completed', amount: 6090, currency: 'CLP', method: 'BANK_TRANSFER', e2e: 'CLLEMB', transaction_id: 'CLLEMB', external_id: 'CL-L-PAGO' };
    await postar({ evento: 'pago', pedido: 'CL-L-PAGO', transacao: 'CLLEMB', e2e: 'CLLEMB', valor: 6090, moeda: 'CLP', cliente: { nome: 'Juan', telefone: '9 8765 4321' } }, 'segredo');
    const confCl = para('56987654321')[0];
    t('CLP: confirmacao para o 56 certo, em espanhol', !!confCl && /Recibimos tu pago de \*\$6\.090 CLP\*/.test(confCl.texto), confCl && confCl.texto.split('\n')[0]);
    const sv2 = require('./src/xpagVendas');
    const ptConf = sv2.textoAoCliente({ nome: 'Carla', valor: 119, moedaCod: 'MXN', pedido: null, numero: '5511912345678' });
    t('confirmacao para +55 continua em portugues', /^Carla, pagamento confirmado/.test(ptConf) && ptConf.includes('MX$ 119,00'));
    t('confirmacao sem numero cai em portugues', /agamento confirmado/.test(sv2.textoAoCliente({ nome: '', valor: 5, moedaCod: 'MXN', numero: null })));

    bloco('cupom: o aviso da equipe mostra o desconto');
    enviadas.length = 0;
    estadoReal.CUPE2E = { ok: true, type: 'cashin', status: 'confirmed', amount: 99, currency: 'MXN', method: 'SPEI', e2e: 'CUPE2E', transaction_id: 'pr_cup', external_id: 'MX-CUP-1' };
    await postar({ evento: 'pago', pedido: 'MX-CUP-1', transacao: 'pr_cup', e2e: 'CUPE2E', valor: 99, moeda: 'MXN', cliente: { nome: 'Ana', telefone: '55 2222 3333' }, cupom: { codigo: 'word10', tipo: 'percentual', valor: 10, descontoBRL: 2.99, subtotalBRL: 29.9 } }, 'segredo');
    const avCup = enviadas.find((e) => e.para === GRUPO);
    t('aviso da equipe: Cupom WORD10 (10%, -R$ 2,99 no pedido)', !!avCup && avCup.texto.includes('Cupom *WORD10* (10%, -R$ 2,99 no pedido)'), avCup && avCup.texto.split('\n').filter((l) => /Cupom/.test(l)).join('|'));
    enviadas.length = 0;
    estadoReal.ZCUP2E2E = { ok: true, type: 'cashin', status: 'confirmed', amount: 109, currency: 'MXN', e2e: 'ZCUP2E2E', transaction_id: 'pr_zcup2', external_id: 'MX-ZCUP-2' };
    await postar({ evento: 'pago', pedido: 'MX-ZCUP-2', transacao: 'pr_zcup2', e2e: 'ZCUP2E2E', valor: 109, moeda: 'MXN' }, 'segredo');
    t('sem cupom: aviso sem a linha de cupom', !/Cupom/.test(enviadas.find((e) => e.para === GRUPO)?.texto || 'Cupom'));

    bloco('lembretes: textos (variantes, emojis, paragrafos)');
    {
      const EMOJI = /\p{Extended_Pictographic}/gu;
      const cobs = {
        mx: { nome: 'Ana', valor: 1090, moeda: 'MXN', pais: 'MX', metodo: 'spei', expiraEm: T0 + 5 * HORA, pagamento: { clabe: '012345678901234567', banco: 'STP', beneficiario: 'Zypher', linkPedido: 'https://phazegames.com/mexico?pedido=X' } },
        ox: { nome: '', valor: 250.5, moeda: 'MXN', pais: 'MX', metodo: 'oxxo', expiraEm: T0 + 30 * HORA, pagamento: { referenciaOxxo: '123', urlVoucher: 'https://v.test/1' } },
        co: { nome: 'Ana', valor: 39900, moeda: 'COP', pais: 'CO', metodo: 'nequi_qr', expiraEm: T0 + 45 * MINU, pagamento: { copiaECola: '000201EMV' } },
        br: { nome: 'Ana', valor: 39900, moeda: 'COP', pais: 'CO', metodo: 'breb', expiraEm: null, pagamento: { chaveBreb: '@k', checkoutUrl: 'https://p.test/1' } },
        cl: { nome: 'Juan', valor: 6090, moeda: 'CLP', pais: 'CL', metodo: 'bank_transfer', expiraEm: null, pagamento: { checkoutUrl: 'https://p.test/cl' } },
      };
      let ruins = [];
      let total = 0;
      for (const [k, c] of Object.entries(cobs)) {
        for (const tipo of ['r1', 'r2', 'r3', 'rapido', 'vencida']) {
          for (const lingua of ['es', 'pt']) {
            for (let vv = 0; vv < 3; vv++) {
              const tx = lem.montarTexto(c, { tipo }, lingua, { agora: T0, variante: vv });
              total++;
              const emojis = (tx.match(EMOJI) || []).length;
              if (emojis < 2 || emojis > 3 || /undefined|null|NaN|—|taobao|fornecedor|proveedor|\*\*/i.test(tx) || !/\n\n/.test(tx) || tx.length > 700) ruins.push(`${k}/${tipo}/${lingua}/${vv}: ${emojis} emojis`);
            }
          }
        }
      }
      t(`${total} textos (5 cobrancas x 5 tipos x 2 idiomas x 3 variantes): 2-3 emojis, paragrafos, sem lixo`, ruins.length === 0, ruins.slice(0, 4).join('; '));
      const a = [0, 1, 2].map((vv) => lem.montarTexto(cobs.mx, { tipo: 'r1' }, 'es', { variante: vv }).split('\n')[0]);
      t('tres variantes de abertura diferentes', new Set(a).size === 3);
      t('MXN com centavos: $250.50 MXN', lem.montarTexto(cobs.ox, { tipo: 'r1' }, 'es', { variante: 0 }).includes('$250.50 MXN'));
      t('sem nome: "¡Hola!" sem virgula solta', /^¡Hola!/.test(lem.montarTexto(cobs.ox, { tipo: 'r1' }, 'es', { variante: 0 })) || /^¡Hola! /.test(lem.montarTexto(cobs.ox, { tipo: 'r1' }, 'es', { variante: 0 })));
    }
  }

  bloco('sem credenciais / desligada');
  config.xpag.enabled = false;
  t('XPAG_ENABLED=false desliga', xpag.configurado() === false);
  out = await operador.executar('#xpag hoje', '5541999999999');
  t('#xpag avisa que esta desligada', /desligada/i.test(out));
  const antes3 = Object.keys(vendas._dados().pedidos).length;
  await postar({ ...corpoWebhook, e2e: 'DESLIGADO1' }, 'segredo');
  t('webhook desligado nao registra', Object.keys(vendas._dados().pedidos).length === antes3);
  config.xpag.enabled = true;
  srv.close();

  console.log(`\n${falhas ? `${falhas} FALHA(S)` : 'tudo certo'}\n`);
  process.exit(falhas ? 1 : 0);
})();
