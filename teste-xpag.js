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
  t('CLP sem centavo', moeda.formatar(25000.4, 'CLP') === 'CLP$ 25.000');
  t('COP sem centavo', moeda.formatar(80000, 'COP') === 'COL$ 80.000');
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
  t('cliente avisado no telefone do pagador (52 + 10 digitos)', !!cli && /pagamento confirmado/i.test(cli.texto) && /MX\$ 119,00/.test(cli.texto));

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
