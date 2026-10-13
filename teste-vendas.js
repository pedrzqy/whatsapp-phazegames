'use strict';

/**
 * Testes do CICLO DE VENDA e do MENU EM LISTA.
 *
 * O que este arquivo protege, em ordem de quanto custa errar:
 *
 *  1. CHAVE ENVIADA DUAS VEZES. Webhook repete — a Nerix reenvia o que não
 *     recebeu 200 a tempo, e um deploy no meio garante isso. Chave é dinheiro.
 *  2. CHAVE NO NÚMERO ERRADO. O telefone do checkout é digitado por gente e
 *     chega de toda forma. Adivinhar o que falta entrega a compra de um
 *     cliente para o telefone de outro.
 *  3. MENU QUE NÃO RESPONDE. Se o toque na lista não resolver, o cliente toca
 *     e recebe o menu de novo — a porta de entrada inteira parece quebrada.
 *
 * Não abre navegador nem fala com a Nerix: sender e API são dublês.
 *
 *   node teste-vendas.js
 */

const os = require('os');
const pathMod = require('path');
const fsMod = require('fs');

// Estado em pasta descartável, ANTES de qualquer require — igual ao
// teste-ponte: rodar isto no servidor não pode encostar no vendas.json real,
// que é quem sabe qual chave já foi entregue.
const DATA_TESTE = pathMod.join(os.tmpdir(), 'phaze-teste-vendas');
fsMod.rmSync(DATA_TESTE, { recursive: true, force: true });
process.env.PONTE_DATA_DIR = DATA_TESTE;

process.env.PONTE_ATIVA = 'true';
process.env.PONTE_HUMANIZA = 'false'; // sem esperas de digitando nos testes
process.env.PONTE_OPERADOR_NUMERO = '5541999999999';
process.env.PONTE_SELLER_CHAT_TITLE = 'loja';

const sender = require('./src/sender');
const nerix = require('./src/nerix');

// Tudo que sai fica aqui em vez de ir para o WhatsApp.
let enviadas = [];
sender.send = async (para, texto, opts = {}) => {
  enviadas.push({ para, texto, opts });
  return true;
};

// A "loja": o pedido que getOrder devolve em cada cenário.
let pedidoFalso = null;
nerix.getOrder = async () => ({ data: pedidoFalso });
nerix.listOrders = async () => ({ data: listaFalsa });
let listaFalsa = [];

const vendas = require('./src/vendas');
const menu = require('./src/menu');

let falhas = 0;
const t = (nome, cond, extra = '') => {
  console.log((cond ? '  ok  ' : 'FALHA') + ' | ' + nome + (extra ? ' -> ' + extra : ''));
  if (!cond) falhas++;
};
const bloco = (nome) => console.log('\n--- ' + nome + ' ---');

const pedido = (over = {}) => ({
  order_number: 'ped-1',
  status: 'paid',
  total: 49.9,
  customer_name: 'Maria Souza',
  customer_email: 'maria@exemplo.com',
  customer_phone: '(41) 99999-8888',
  items: [{ product_name: 'Hollow Knight', quantity: 1, product_key: 'ABC-123-XYZ' }],
  ...over,
});

const OP = '5541999999999';
const CLI = '5541999998888';

(async () => {
  // ── Telefone ───────────────────────────────────────────────
  //
  // O campo é preenchido por gente no checkout e chega de tudo. O que não for
  // inequívoco tem que virar null: entregar no número errado não tem desfazer.
  bloco('telefone do checkout vira número de WhatsApp');

  t('com máscara', vendas.paraWhatsApp('(41) 99999-8888') === '5541999998888');
  t('só dígitos, 11', vendas.paraWhatsApp('41999998888') === '5541999998888');
  t('fixo, 10 dígitos', vendas.paraWhatsApp('4133334444') === '554133334444');
  t('já com 55', vendas.paraWhatsApp('5541999998888') === '5541999998888');
  t('com +55 e espaços', vendas.paraWhatsApp('+55 41 99999-8888') === '5541999998888');
  t('vazio não vira número', vendas.paraWhatsApp('') === null);
  t('curto demais não vira número', vendas.paraWhatsApp('99998888') === null);
  // Este é o que importa: um número internacional ou digitado errado não pode
  // ganhar um 55 na frente e virar o telefone de outra pessoa no Brasil.
  t('longo demais não vira número', vendas.paraWhatsApp('123456789012345') === null);
  t('estrangeiro não ganha 55', vendas.paraWhatsApp('351912345678') === null);

  // ── México (+52) ───────────────────────────────────────────
  //
  // A loja também vende no México. Antes, tudo aqui assumia Brasil: 10 dígitos
  // ganhavam 55 (e iam para um estranho) e 52... não passava no filtro, então
  // nem Pix, nem confirmação, nem chave chegavam.
  bloco('telefone mexicano vira número de WhatsApp');
  const MX = '525512345678';
  t('+52 1 55 1234 5678 (móvil antigo)', vendas.paraWhatsApp('+52 1 55 1234 5678') === MX);
  t('+52 55 1234 5678', vendas.paraWhatsApp('+52 55 1234 5678') === MX);
  t('52 55 1234 5678, sem +', vendas.paraWhatsApp('52 55 1234 5678') === MX);
  t('521 + 10, sem +', vendas.paraWhatsApp('5215512345678') === MX);
  t('00 52 na frente', vendas.paraWhatsApp('0052 55 1234 5678') === MX);
  t('com máscara', vendas.paraWhatsApp('+52 (55) 1234-5678') === MX);
  t('10 dígitos COM país México', vendas.paraWhatsApp('5512345678', 'MX') === MX);
  t('  país como nome', vendas.paraWhatsApp('5512345678', 'México') === MX);
  t('  país como moeda do pedido', vendas.paraWhatsApp('5512345678', 'MXN') === MX);
  t('1 + 10 com país México', vendas.paraWhatsApp('15512345678', 'MX') === MX);
  t('10 dígitos sem país continua Brasil', vendas.paraWhatsApp('4133334444') === '554133334444');
  t('10 dígitos cujo início não é DDD brasileiro é México', vendas.paraWhatsApp('5712345678') === '525712345678');
  t('Brasil com país BR explícito', vendas.paraWhatsApp('5512345678', 'BR') === '555512345678');
  t('+55 mal formado não vira número', vendas.paraWhatsApp('+55 41 9999') === null);
  t('+52 mal formado não vira número', vendas.paraWhatsApp('+52 55 1234') === null);
  t('outro país com + é respeitado', vendas.paraWhatsApp('+351 912 345 678') === '351912345678');
  t('+55 continua igual', vendas.paraWhatsApp('+55 (41) 99999-8888') === '5541999998888');
  const tel = require('./src/telefone');
  t('521 e 52 são o mesmo número', tel.mesmoNumero('5215512345678', '525512345678'));
  t('521 e 52 de outro número não casam', !tel.mesmoNumero('5215512345678', '525512345679'));
  t('nono dígito BR continua casando', tel.mesmoNumero('5541999998888', '554199998888'));
  t('BR e MX nunca casam', !tel.mesmoNumero('5541999998888', '525512345678'));
  t('país lido do pedido: country', tel.paisDoPedido({ customer: { country: 'MX' } }) === 'MX');
  t('país lido do pedido: moeda', tel.paisDoPedido({ currency: 'MXN' }) === 'MX');
  t('sem pista, sem país', tel.paisDoPedido({ customer_phone: '5512345678' }) === null);

  // ── O Pix na hora ──────────────────────────────────────────
  //
  // Relato do dono: "o sistema de mandar qr-code precisa ser imediato, não tem
  // sentido ser 45 min depois".
  //
  // Quem fechava a compra PELA CONVERSA sempre recebeu o Pix na mesma resposta.
  // Quem fazia o pedido no site caía na varredura de hora em hora, que só
  // começa a olhar o pedido com DUAS HORAS de idade — ela foi escrita como
  // cutucada em quem desistiu, e virou sem querer o único caminho de quem
  // acabou de comprar.
  const PROIBIDO_AQUI = require('./src/ponte/politica').vocabularioProibido();
  const PIX_FALSO = '00020126BR-PIX-COPIA-E-COLA-1234';
  const pendente = (over = {}) =>
    pedido({
      status: 'pending',
      items: [{ product_name: 'Hollow Knight', quantity: 1, product_key: null }],
      payment: { pix_qr_code: PIX_FALSO },
      ...over,
    });

  bloco('pedido em aberto recebe o Pix na hora');

  enviadas = [];
  pedidoFalso = pendente({ order_number: 'ped-pix' });
  await vendas.onEvento({ event: 'order.created', data: { order_number: 'ped-pix' } });

  const aoCli = enviadas.filter((e) => e.para === CLI);
  t('o cliente recebe na hora', aoCli.length === 2, `${aoCli.length} mensagem(ns)`);
  t('  a primeira diz qual é o pedido', /ped-pix/i.test(aoCli[0]?.texto || ''),
    aoCli[0]?.texto.split('\n')[1]);
  // SOZINHO na segunda, sem texto em volta: é assim que ele é copiado de uma
  // vez no celular. Texto colado junto faz a pessoa selecionar na mão e errar.
  t('  e o Pix vai sozinho na segunda', aoCli[1]?.texto === PIX_FALSO, aoCli[1]?.texto);
  t('  sem vocabulário proibido',
    !PROIBIDO_AQUI.test(aoCli.map((e) => e.texto).join('\n')),
    (aoCli.map((e) => e.texto).join('\n').match(PROIBIDO_AQUI) || ['limpo'])[0]);

  bloco('o mesmo pedido não é cobrado duas vezes');
  enviadas = [];
  await vendas.onEvento({ event: 'order.created', data: { order_number: 'ped-pix' } });
  t('nada é reenviado', enviadas.length === 0, JSON.stringify(enviadas.map((e) => e.para)));

  // Os `case` de "pedido criado" são um palpite sobre como a loja nomeia o
  // evento. Se ela usar outro nome, o defeito voltaria por uma porta diferente
  // — e o cliente esperaria as duas horas de novo, sem nada no log parecendo
  // errado.
  bloco('nome de evento desconhecido não custa a venda');
  enviadas = [];
  pedidoFalso = pendente({ order_number: 'ped-pix2' });
  await vendas.onEvento({ event: 'order.qualquer_coisa_nova', data: { order_number: 'ped-pix2' } });
  t('o Pix sai mesmo assim', enviadas.filter((e) => e.para === CLI).length === 2,
    `${enviadas.filter((e) => e.para === CLI).length} mensagem(ns)`);

  // ── Nome de evento desconhecido, pedido PAGO ───────────────
  //
  // A loja aprovou uma venda de verdade e nada aconteceu. O nome que chegou não
  // era nenhum dos que estavam escritos no switch, e o caminho de sobra só
  // sabia mandar Pix — que desiste na primeira linha quando o pedido já está
  // pago. O aviso nao saia, e o log dizia so "evento sem tratamento", que
  // parece informacao e nao parece problema.
  // ── status x payment_status ────────────────────────────────
  //
  // A Nerix separa o status do PEDIDO (pending, completed, cancelled,
  // delivered) do status do PAGAMENTO (pending, paid, refunded). Um pedido
  // recém-pago chega com `status: "pending"` e `payment_status: "paid"`, e
  // lendo o primeiro ele era considerado NÃO PAGO.
  //
  // O estrago é calado: cobrança e link de pagamento voltam para quem já pagou,
  // e alguns pagam de novo.
  bloco('pedido pago com status ainda pendente é lido como pago');
  const formatOrder = require('./src/tools').formatOrder;
  const recemPago = formatOrder({
    order_number: 'NX-2001',
    status: 'pending',
    payment_status: 'paid',
    total: '59.80',
    items: [],
  });
  t('payment_status manda', recemPago.pago === true, JSON.stringify(recemPago.status));
  t('  e não oferece pagamento a quem já pagou',
    !recemPago.pix_copia_e_cola && !recemPago.link_pagamento);
  // E o contrário continua valendo: estornado não é pago.
  t('estornado não vira pago',
    formatOrder({ order_number: 'x', status: 'pending', payment_status: 'refunded' }).pago === false);

  // ── O pedido vem aninhado em data.order ────────────────────
  //
  // O #status entregou o diagnostico: "A loja mandou order.approved, SEM numero
  // de pedido. Campos que vieram: order."
  //
  // A documentacao mostra `data.order_number` direto em `data`. O que chega de
  // verdade e `data.order.order_number`, um nivel mais fundo -- e o carregar
  // desistia antes de qualquer coisa. O painel da loja mostrava 200 Success, o
  // #status dizia "nenhum aviso recebido", e as duas telas estavam certas: o
  // 200 sai antes do processamento. Uma venda aprovada nao virou aviso nenhum.
  bloco('pedido aninhado em data.order é encontrado');

  enviadas = [];
  pedidoFalso = pedido({ order_number: 'NX-2050' });
  await vendas.onEvento({
    event: 'order.approved',
    data: { order: { order_number: 'NX-2050', status: 'pending', payment_status: 'paid' } },
  });
  t('o operador é avisado', enviadas.some((e) => e.para === OP),
    JSON.stringify(enviadas.map((e) => e.para)));
  t('  e o cliente também', enviadas.some((e) => e.para === CLI));

  // A forma da documentacao continua valendo: ela pode voltar a ser a real num
  // deploy deles, e o desfecho nao pode ser silencio de novo.
  t('a forma da documentação continua funcionando',
    vendas.acharPedido({ data: { order_number: 'NX-1054' } })?.order_number === 'NX-1054');
  t('e corpo sem pedido nenhum devolve nada',
    vendas.acharPedido({ event: 'ping', data: {} }) === null);

  bloco('venda aprovada avisa mesmo com nome de evento desconhecido');

  enviadas = [];
  pedidoFalso = pedido({ order_number: 'nome-estranho' });
  await vendas.onEvento({ event: 'venda.aprovada', data: { order_number: 'nome-estranho' } });
  const avisoOp = enviadas.find((e) => e.para === OP);
  t('o operador é avisado do mesmo jeito', Boolean(avisoOp), JSON.stringify(enviadas.map((e) => e.para)));
  t('  com o valor da venda', /49[.,]9/.test(avisoOp?.texto || ''), avisoOp?.texto.split('\n')[0]);
  t('o cliente recebe a confirmação', enviadas.some((e) => e.para === CLI));

  // E não repete quando o evento com o nome certo chegar logo depois.
  enviadas = [];
  await vendas.onEvento({ event: 'order.paid', data: { order_number: 'nome-estranho' } });
  t('  e o evento certo depois não repete nada', enviadas.length === 0,
    JSON.stringify(enviadas.map((e) => e.para)));

  bloco('quem já pagou não recebe cobrança');
  enviadas = [];
  pedidoFalso = pedido({ order_number: 'ped-pago', payment: { pix_qr_code: PIX_FALSO } });
  await vendas.onEvento({ event: 'order.qualquer_coisa_nova', data: { order_number: 'ped-pago' } });
  t('nada de Pix para pedido pago', !enviadas.some((e) => e.texto === PIX_FALSO),
    JSON.stringify(enviadas.map((e) => e.texto?.slice(0, 20))));

  // ── order.paid ─────────────────────────────────────────────
  bloco('venda paga avisa operador e cliente');

  enviadas = [];
  pedidoFalso = pedido();
  await vendas.onEvento({ event: 'order.paid', data: { order_number: 'ped-1' } });

  const aoOperador = enviadas.find((e) => e.para === OP);
  const aoCliente = enviadas.find((e) => e.para === CLI);

  t('o operador é avisado', Boolean(aoOperador));
  t('com o telefone do cliente', aoOperador?.texto.includes('99999-8888'), aoOperador?.texto.split('\n')[3]);
  t('e o valor', aoOperador?.texto.includes('49.90') || aoOperador?.texto.includes('49,90'));
  t('e diz que a chave saiu', /chave em estoque/i.test(aoOperador?.texto || ''));
  // O aviso de venda é a mensagem que o dono mais lê, e ela escapou da regra
  // por meses: dizia "entrega automática", e "automática" é palavra barrada.
  // A regra vale para o que chega NELE também — sai pelo mesmo número que fala
  // com o cliente, e basta um encaminhamento para virar problema.
  t('e sem vocabulário proibido',
    !require('./src/ponte/politica').vocabularioProibido().test(aoOperador?.texto || ''),
    (aoOperador?.texto.match(require('./src/ponte/politica').vocabularioProibido()) || ['limpo'])[0]);
  t('o cliente recebe confirmação', Boolean(aoCliente));
  t('pelo primeiro nome', aoCliente?.texto.startsWith('Maria'), aoCliente?.texto.split('\n')[0]);
  // Chave em estoque: a entrega chega em seguida pelo delivered, e um "estou
  // preparando" no meio deixaria o cliente esperando o que já vem.
  t('sem prometer preparo quando há chave', !/preparando/i.test(aoCliente?.texto || ''));

  bloco('o mesmo evento de novo não repete nada');
  enviadas = [];
  await vendas.onEvento({ event: 'order.paid', data: { order_number: 'ped-1' } });
  t('nada é reenviado', enviadas.length === 0, JSON.stringify(enviadas.map((e) => e.para)));

  // ── Sem chave = trabalho para alguém ───────────────────────
  bloco('pedido sem chave vira tarefa, não silêncio');

  enviadas = [];
  pedidoFalso = pedido({
    order_number: 'ped-2',
    items: [{ product_name: 'Conta Steam', quantity: 1, product_key: null }],
  });
  await vendas.onEvento({ event: 'order.paid', data: { order_number: 'ped-2' } });

  const semChave = enviadas.find((e) => e.para === OP);
  t('o operador é avisado', Boolean(semChave));
  t('e o aviso diz que é na mão', /sem chave/i.test(semChave?.texto || ''), semChave?.texto.split('\n').pop());
  const cli2 = enviadas.find((e) => e.para === CLI);
  t('o cliente é avisado que está sendo preparado', /preparando/i.test(cli2?.texto || ''));

  // ── order.delivered ────────────────────────────────────────
  bloco('entrega da chave');

  enviadas = [];
  pedidoFalso = pedido({ order_number: 'ped-3', status: 'delivered' });
  await vendas.onEvento({ event: 'order.delivered', data: { order_number: 'ped-3' } });

  const entrega = enviadas.find((e) => e.para === CLI && e.texto.includes('ABC-123-XYZ'));
  t('a chave chega no cliente', Boolean(entrega));
  t('com o nome do jogo', entrega?.texto.includes('Hollow Knight'));

  bloco('a chave NÃO sai duas vezes');
  enviadas = [];
  await vendas.onEvento({ event: 'order.delivered', data: { order_number: 'ped-3' } });
  t('segundo webhook não reenvia', !enviadas.some((e) => e.texto.includes('ABC-123-XYZ')),
    JSON.stringify(enviadas.map((e) => e.para)));

  bloco('pedido do México: Pix e chave chegam');
  const CLI_MX = '525512345678';
  for (const [rotulo, over] of [
    ['+52 1 55 1234 5678', { customer_phone: '+52 1 55 1234 5678' }],
    ['52 55 1234 5678', { customer_phone: '52 55 1234 5678' }],
    ['5512345678 com país no cliente', { customer_phone: '5512345678', customer: { country: 'MX' } }],
    ['5512345678 com moeda MXN', { customer_phone: '5512345678', currency: 'MXN' }],
  ]) {
    const cod = 'mx-' + rotulo.replace(/\W/g, '');
    enviadas = [];
    pedidoFalso = pendente({ order_number: cod, ...over });
    await vendas.onEvento({ event: 'order.created', data: { order_number: cod } });
    const pix = enviadas.filter((e) => e.para === CLI_MX);
    t(`Pix chega: ${rotulo}`, pix.length === 2 && pix[1].texto === PIX_FALSO,
      JSON.stringify(enviadas.map((e) => e.para)));
    t('  e nada foi para número brasileiro', !enviadas.some((e) => e.para.startsWith('55') && e.para !== OP));

    enviadas = [];
    pedidoFalso = pedido({ order_number: cod + 'd', status: 'delivered', ...over,
      items: [{ product_name: 'Celeste', quantity: 1, product_key: 'MX-KEY-1' }] });
    await vendas.onEvento({ event: 'order.delivered', data: { order_number: cod + 'd' } });
    t(`chave chega: ${rotulo}`,
      enviadas.some((e) => e.para === CLI_MX && e.texto.includes('MX-KEY-1')),
      JSON.stringify(enviadas.map((e) => e.para)));
  }

  bloco('pedidos achados pelo número mexicano (#meulogin, status)');
  listaFalsa = [
    { order_number: 'mx-a', customer_phone: '+52 1 55 1234 5678', created_at: new Date().toISOString(), status: 'paid' },
    { order_number: 'mx-b', customer_phone: '5512345678', customer: { country: 'MX' }, created_at: new Date().toISOString(), status: 'paid' },
    { order_number: 'mx-outro', customer_phone: '+52 55 9999 0000', created_at: new Date().toISOString(), status: 'paid' },
    { order_number: 'br-igual-fim', customer_phone: '5512345678', created_at: new Date().toISOString(), status: 'paid' },
  ];
  // O WhatsApp entrega o remetente como 52... ou 521..., e as duas têm que achar.
  for (const jid of ['525512345678', '5215512345678']) {
    const meusMx = await vendas.pedidosDoTelefone(jid);
    t(`acha pelo JID ${jid}`, meusMx.map((p) => p.order_number).sort().join() === 'mx-a,mx-b',
      JSON.stringify(meusMx.map((p) => p.order_number)));
  }
  const brs = await vendas.pedidosDoTelefone('555512345678');
  t('o brasileiro de mesmos dígitos só vê o dele', brs.map((p) => p.order_number).join() === 'br-igual-fim',
    JSON.stringify(brs.map((p) => p.order_number)));

  bloco('evolution resolve o JID mexicano (onWhatsApp), com cache');
  {
    const evolution = require('./src/evolution');
    const orig = evolution.http.post;
    const chamadas = [];
    evolution.http.post = async (url, corpo) => {
      chamadas.push({ url, corpo });
      // Só a forma 521 existe na conta (caso antigo).
      return { data: corpo.numbers.map((n) => ({ number: n, exists: n === '5215599990000', jid: `${n}@s.whatsapp.net` })) };
    };
    try {
      evolution._cacheJid.clear();
      const d1 = await evolution.destino('525599990000', 'inst');
      t('acha a forma que existe', d1 === '5215599990000', d1);
      t('  perguntou as duas formas', chamadas[0]?.url === '/chat/whatsappNumbers/inst' &&
        chamadas[0].corpo.numbers.join() === '525599990000,5215599990000', JSON.stringify(chamadas[0]));
      await evolution.destino('525599990000', 'inst');
      t('  segunda vez vem do cache', chamadas.length === 1, `${chamadas.length} chamada(s)`);
      const br = await evolution.destino('5541999998888', 'inst');
      t('Brasil passa direto, sem consulta', br === '5541999998888' && chamadas.length === 1);
      const grupo = await evolution.destino('120363@g.us', 'inst');
      t('grupo passa direto', grupo === '120363@g.us' && chamadas.length === 1);
      evolution.http.post = async () => { throw new Error('fora do ar'); };
      const falho = await evolution.destino('525511110000', 'inst');
      t('consulta falhando não impede o envio', falho === '525511110000', falho);
    } finally {
      evolution.http.post = orig;
    }
  }

  bloco('telefone impossível não vira envio às cegas');
  enviadas = [];
  pedidoFalso = pedido({
    order_number: 'ped-4',
    status: 'delivered',
    customer_phone: '123',
    items: [{ product_name: 'Celeste', quantity: 1, product_key: 'ZZZ-999' }],
  });
  await vendas.onEvento({ event: 'order.delivered', data: { order_number: 'ped-4' } });

  t('nada foi mandado para um número inventado',
    !enviadas.some((e) => e.para !== OP), JSON.stringify(enviadas.map((e) => e.para)));
  // Procura pelo CONTEÚDO: no delivered o operador recebe duas mensagens (a
  // venda e a entrega manual), e pegar "a primeira do operador" testaria a
  // errada.
  const manual = enviadas.find((e) => e.para === OP && /entrega manual/i.test(e.texto));
  t('o operador recebe a entrega manual', Boolean(manual));
  t('com o e-mail para onde mandar', Boolean(manual?.texto.includes('maria@exemplo.com')));
  t('e a chave vai junto, para ele copiar', Boolean(manual?.texto.includes('ZZZ-999')));

  // ── Lembrete de Pix ────────────────────────────────────────
  bloco('lembrete de pagamento pendente');

  const agora = Date.now();
  const horas = (h) => new Date(agora - h * 3600_000).toISOString();
  listaFalsa = [
    // Novo demais: quem acabou de gerar o Pix ainda está pagando.
    { order_number: 'novo', status: 'pending', total: 10, created_at: horas(1), customer_phone: '41999990001', customer_name: 'Ana' },
    // No ponto.
    { order_number: 'certo', status: 'pending', total: 20, created_at: horas(5), customer_phone: '41999990002', customer_name: 'Bruno' },
    // Velho demais: o Pix já expirou e o link está morto.
    { order_number: 'velho', status: 'pending', total: 30, created_at: horas(72), customer_phone: '41999990003', customer_name: 'Carla' },
    // Sem telefone utilizável.
    { order_number: 'semtel', status: 'pending', total: 40, created_at: horas(5), customer_phone: '', customer_name: 'Davi' },
    // Já pago: o status da lista pode estar velho, mas este não está.
    { order_number: 'pago', status: 'paid', total: 50, created_at: horas(5), customer_phone: '41999990005', customer_name: 'Eva' },
  ];

  enviadas = [];
  await vendas.lembrarPixPendente();
  const alvos = enviadas.map((e) => e.para);

  // A varredura só roda em horário civil. Fora dele o certo é não mandar nada,
  // e o teste não pode falhar por causa da hora em que foi rodado.
  const horaBRT = Number(
    new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false })
      .format(new Date()),
  );
  const civil = horaBRT >= 9 && horaBRT < 21;

  if (civil) {
    t('só o pedido na janela é cutucado', alvos.length === 1, JSON.stringify(alvos));
    t('e é o certo', alvos[0] === '5541999990002', alvos[0]);
    t('o recém-criado não é cutucado', !alvos.includes('5541999990001'));
    t('o expirado não é cutucado', !alvos.includes('5541999990003'));
    t('o já pago não é cutucado', !alvos.includes('5541999990005'));

    enviadas = [];
    await vendas.lembrarPixPendente();
    t('e ninguém é cutucado duas vezes', enviadas.length === 0, JSON.stringify(enviadas.map((e) => e.para)));

    // ── A ENXURRADA ──────────────────────────────────────────
    //
    // Relato com print: quatro mensagens seguidas para o mesmo cliente, todas
    // iguais menos pelo código. A trava de "não repetir" era por PEDIDO, e ele
    // tinha quatro em aberto.
    //
    // E não eram quatro compras: eram quatro tentativas da mesma, os valores se
    // repetiam dois a dois. Do lado de lá aquilo não parece cobrança, parece
    // defeito, e chega quando a pessoa ainda está decidindo.
    const antonio = '11959460592';
    listaFalsa = [
      { order_number: 'tent-1', status: 'pending', total: 136.92, created_at: horas(5), customer_phone: antonio, customer_name: 'Antonio Silva' },
      { order_number: 'tent-2', status: 'pending', total: 143.99, created_at: horas(4), customer_phone: antonio, customer_name: 'Antonio Silva' },
      { order_number: 'tent-3', status: 'pending', total: 143.99, created_at: horas(3), customer_phone: antonio, customer_name: 'Antonio Silva' },
      { order_number: 'tent-4', status: 'pending', total: 136.92, created_at: horas(2.5), customer_phone: antonio, customer_name: 'Antonio Silva' },
    ];
    enviadas = [];
    await vendas.lembrarPixPendente();
    t('quatro tentativas viram UMA mensagem', enviadas.length === 1, `${enviadas.length} mensagem(ns)`);
    t('  falando do pedido mais recente', /tent-4/.test(enviadas[0]?.texto || ''),
      (enviadas[0]?.texto || '').split('\n')[2]);

    // Os outros três não podem voltar um a um nas próximas voltas: seria a
    // mesma enxurrada, só que espalhada por quatro horas.
    enviadas = [];
    await vendas.lembrarPixPendente();
    t('  e os outros não voltam depois', enviadas.length === 0,
      JSON.stringify(enviadas.map((e) => e.texto?.slice(0, 30))));

    // Duas pessoas diferentes continuam recebendo uma cada: o agrupamento não
    // pode virar "uma mensagem por varredura".
    listaFalsa = [
      { order_number: 'p1', status: 'pending', total: 10, created_at: horas(5), customer_phone: '41988880001', customer_name: 'Um' },
      { order_number: 'p2', status: 'pending', total: 20, created_at: horas(5), customer_phone: '41988880002', customer_name: 'Dois' },
    ];
    enviadas = [];
    await vendas.lembrarPixPendente();
    t('duas pessoas recebem uma cada', enviadas.length === 2, `${enviadas.length} mensagem(ns)`);
  } else {
    t('fora do horário civil não cutuca ninguém', enviadas.length === 0, `${horaBRT}h BRT`);
  }

  // ── Pedidos pelo telefone ──────────────────────────────────
  bloco('consulta de pedido pelo telefone');

  listaFalsa = [
    { order_number: 'meu-antigo', customer_phone: '41999998888', created_at: horas(48), status: 'paid' },
    { order_number: 'de-outro', customer_phone: '11955554444', created_at: horas(2), status: 'paid' },
    { order_number: 'meu-novo', customer_phone: '(41) 99999-8888', created_at: horas(1), status: 'paid' },
  ];

  const meus = await vendas.pedidosDoTelefone(CLI);
  t('acha os pedidos do número', meus.length === 2, `${meus.length}`);
  // O filtro é LOCAL de propósito: uma API que ignore o parâmetro `search`
  // devolveria a loja inteira, e sem esta comparação o cliente veria pedido de
  // outra pessoa.
  t('e NÃO traz o de outro cliente', !meus.some((p) => p.order_number === 'de-outro'),
    JSON.stringify(meus.map((p) => p.order_number)));
  t('o mais recente vem primeiro', meus[0].order_number === 'meu-novo', meus[0].order_number);
  t('telefone que não normaliza não busca nada', (await vendas.pedidosDoTelefone('123')).length === 0);

  // ── Menu em lista ──────────────────────────────────────────
  bloco('menu em lista');

  const l = menu.lista('main');
  t('tem uma linha por opção', l.rows.length === menu.NODES.main.options.length);
  t('todo título cabe no limite do WhatsApp', l.rows.every((r) => r.title.length <= 24));
  t('o rowId é o número da opção', l.rows.map((r) => r.rowId).join(',') === '1,2,3,4,5,6,7,8');
  t('o rodapé lembra que dá para digitar', /digitar o n[úu]mero/i.test(l.footer));

  t('número resolve', menu.resolve('main', '3')?.topic === 'plataforma_steam');
  t('rowId resolve igual', menu.resolve('main', l.rows[2].rowId)?.topic === 'plataforma_steam');
  t('título exibido resolve', menu.resolve('main', l.rows[2].title)?.topic === 'plataforma_steam', l.rows[2].title);
  t('rótulo inteiro resolve', menu.resolve('main', menu.NODES.main.options[4].label)?.action === 'codigo');

  // O casamento por título é por IGUALDADE. Prefixo parecia mais tolerante e
  // era armadilha: "suporte" mandaria o cliente para o ramo do Nintendo sem
  // ele ter escolhido nada.
  t('texto livre continua caindo no fallback', menu.resolve('main', 'suporte') === null);
  t('outra palavra solta também', menu.resolve('main', 'problema') === null);
  t('opção inexistente não resolve', menu.resolve('main', '99') === null);
  t('vazio não resolve', menu.resolve('main', '') === null);

  // ── O "#5" ─────────────────────────────────────────────────
  //
  // Print de cliente real: o menu diz no rodapé "digite *#inicio* para voltar".
  // Ele leu aquilo, concluiu que nesta loja comando começa com cerquilha, e
  // respondeu "#5".
  //
  // Ele não errou. Generalizou a única regra que a gente tinha ensinado, e
  // recusar isso é devolver o menu para quem respondeu certo -- do lado dele,
  // quem está quebrado é o bot.
  t('"#5" resolve igual a "5"', menu.resolve('main', '#5')?.action === 'codigo', '#5');
  t('com espaço depois do #', menu.resolve('main', '# 5')?.action === 'codigo');
  t('com ponto junto também', menu.resolve('main', '#5.')?.action === 'codigo');
  t('"opcao #5" também', menu.resolve('main', 'opcao #5')?.action === 'codigo');
  // A tolerância não pode virar buraco: fora da faixa continua fora, e o
  // comando de verdade continua sendo comando.
  t('#9 fora da faixa não resolve', menu.resolve('main', '#9') === null);
  t('#inicio não vira opção', menu.resolve('main', '#inicio') === null);

  const ld = menu.lista('duvidas', 'Não achei essa opção');
  t('o prefixo entra na descrição da lista', ld.description.startsWith('Não achei essa opção'));
  t('e a descrição não leva asterisco cru', !ld.description.includes('*'), ld.description);

  // As redes de vocabulario, da FONTE UNICA (politica.js). Copiar a lista em
  // cada arquivo de teste e como "script" escapou uma vez: as copias divergem
  // e cada teste passa a provar coisa diferente.
  const AUTOMACAO = require('./src/ponte/politica').vocabularioProibido();
  const PROIBIDO = /fornecedor|taobao|chin[êe]s|vendedor|parceiro/i;
  const REPASSE = /encaminh\w*|repass\w*|terceir\w*|nosso\s+parceir\w*/i;

  // ── Depois da entrega ──────────────────────────────────────
  //
  // O bot entregava a chave e calava. Se ela não ativou, quem descobria era o
  // cliente, sozinho — e a primeira notícia disso chegava como reclamação,
  // quase sempre depois de ele já ter desistido.
  bloco('conferir a entrega');

  const posvenda = require('./src/posvenda');
  const vendasMod = require('./src/vendas');
  const cfgPV = require('./src/config');
  const storePV = require('./src/store');
  const senderPV = require('./src/sender');

  const HORA_PV = 3600_000;
  const CLI_PV = '5541977770001';

  // Hora fixa, e o pedido datado a partir DELA.
  //
  // Misturar um `agora` fixo com um `entregue` vindo de Date.now() faz a idade
  // do pedido sair negativa -- o mesmo defeito do relogio decidindo o
  // resultado, so que ao contrario: nunca passava, em vez de as vezes.
  const AGORA_PV = Date.UTC(2026, 7, 27, 17, 0); // 14h BRT, quinta

  /** Monta um pedido entregue ha N horas e roda a varredura. */
  async function varrer(horasAtras, extra = {}) {
    const d = vendasMod._dados();
    d.pedidos = {};
    d.pedidos.PED_PV = {
      visto: AGORA_PV,
      entregue: AGORA_PV - horasAtras * HORA_PV,
      telefone: CLI_PV,
      nome: 'Ana Silva',
      ...extra,
    };
    const enviadas = [];
    const antes = senderPV.send;
    senderPV.send = async (para, txt) => { enviadas.push({ para, texto: String(txt) }); };
    try {
      // Hora fixa dentro do expediente: sem isto o teste passa de manha e
      // falha de madrugada, que e o defeito do relogio decidindo o resultado.
      await posvenda.conferirEntregas(AGORA_PV);
    } finally {
      senderPV.send = antes;
    }
    return { enviadas, registro: vendasMod._dados().pedidos.PED_PV };
  }

  // Cedo demais: o cliente compra e abre o jogo quando dá. Perguntar em
  // seguida só interrompe.
  const cedo = await varrer(1);
  t('1h depois ainda não pergunta', cedo.enviadas.length === 0, String(cedo.enviadas.length));
  t('  e não marca como conferido', !cedo.registro.conferido);

  const naHora = await varrer(4);
  t('4h depois pergunta', naHora.enviadas.length === 1, String(naHora.enviadas.length));
  t('  para o cliente certo', naHora.enviadas[0]?.para === CLI_PV, naHora.enviadas[0]?.para);
  // Pergunta ABERTA: "tudo certo?" convida a um "sim" automático de quem nem
  // tentou, e o silêncio depois disso parece confirmação.
  t('  perguntando da ativação', /ativa[çc][ãa]o/i.test(naHora.enviadas[0]?.texto || ''),
    naHora.enviadas[0]?.texto);
  t('  e abrindo caminho para responder', /me conta|resolvo/i.test(naHora.enviadas[0]?.texto || ''));
  t('  sem entregar a origem nem admitir defeito',
    !PROIBIDO.test(naHora.enviadas[0]?.texto || '') &&
      !AUTOMACAO.test(naHora.enviadas[0]?.texto || '') &&
      !/erro|falha|problema/i.test(naHora.enviadas[0]?.texto || ''),
    naHora.enviadas[0]?.texto);

  // Marca ANTES de enviar: uma falha no meio faria a pergunta sair de novo na
  // varredura seguinte, e de novo, e de novo.
  t('  e marca para não repetir', Boolean(naHora.registro.conferido));

  const jaConferido = await varrer(4, { conferido: AGORA_PV });
  t('não pergunta duas vezes', jaConferido.enviadas.length === 0, String(jaConferido.enviadas.length));

  // Velho demais: a pergunta soa estranha, mas ele precisa sair da fila de
  // avaliação — senão é reavaliado em toda varredura para sempre.
  const velho = await varrer(24 * 5);
  t('pedido velho não recebe a pergunta', velho.enviadas.length === 0);
  t('  mas sai da fila de avaliação', Boolean(velho.registro.conferido));

  // Cliente com atendente humano NÃO recebe: ele está no meio de um problema,
  // e a pergunta do bot atropela quem está resolvendo.
  storePV.saveContact(CLI_PV, { paused: true });
  const comAtendente = await varrer(4);
  t('quem está com atendente não é interrompido', comAtendente.enviadas.length === 0);
  storePV.saveContact(CLI_PV, { paused: false });

  // Sem telefone utilizável não dá para perguntar — e também não pode ficar
  // rodando para sempre.
  const semTelefone = await varrer(4, { telefone: '' });
  t('sem telefone não tenta', semTelefone.enviadas.length === 0);
  t('  e sai da fila', Boolean(semTelefone.registro.conferido));

  // Desligado é desligado.
  const conferirAntes = cfgPV.posvenda.conferirLigado;
  cfgPV.posvenda.conferirLigado = false;
  const desligadoPV = await varrer(4);
  t('desligado não pergunta nada', desligadoPV.enviadas.length === 0);
  cfgPV.posvenda.conferirLigado = conferirAntes;

  // ── Reativar quem sumiu ────────────────────────────────────
  //
  // É a única coisa do bot que fala com quem NÃO puxou conversa. Mensagem em
  // massa partindo de um número comercial é o padrão que faz o WhatsApp
  // derrubar o número — e derrubar o número custa o atendimento inteiro.
  bloco('reativar quem sumiu');

  t('nasce DESLIGADO', cfgPV.posvenda.reativarLigado === false);

  const reativarAntes = { ...cfgPV.posvenda };
  cfgPV.posvenda.reativarLigado = true;
  cfgPV.posvenda.reativarDias = 45;
  cfgPV.posvenda.reativarPorDia = 2;
  cfgPV.posvenda.reativarIntervaloDias = 120;

  const DIA_PV = 24 * HORA_PV;
  const agoraPV = Date.UTC(2026, 7, 27, 17, 0);

  // Quatro perfis diferentes, um por regra.
  storePV.saveContact('5541977771111', { engaged: true, lastSeen: agoraPV - 60 * DIA_PV });
  storePV.saveContact('5541977772222', { engaged: true, lastSeen: agoraPV - 50 * DIA_PV });
  storePV.saveContact('5541977773333', { engaged: true, lastSeen: agoraPV - 90 * DIA_PV });
  // Nunca conversou com o bot: para ele isto seria mensagem fria.
  storePV.saveContact('5541977774444', { engaged: false, lastSeen: agoraPV - 90 * DIA_PV });
  // Está com atendente.
  storePV.saveContact('5541977775555', { engaged: true, paused: true, lastSeen: agoraPV - 90 * DIA_PV });
  // Sumiu há pouco.
  storePV.saveContact('5541977776666', { engaged: true, lastSeen: agoraPV - 10 * DIA_PV });
  // Já foi reativado faz pouco tempo.
  storePV.saveContact('5541977777777', {
    engaged: true, lastSeen: agoraPV - 90 * DIA_PV, reativadoEm: agoraPV - 30 * DIA_PV,
  });

  const reativadas = [];
  const sendAntesRe = senderPV.send;
  senderPV.send = async (para, txt) => { reativadas.push({ para, texto: String(txt) }); };
  await posvenda.reativar(agoraPV);
  senderPV.send = sendAntesRe;

  const alvosReativados = reativadas.map((r) => r.para);
  t('respeita o teto por dia', reativadas.length === 2, String(reativadas.length));
  // Os mais RECENTES primeiro: quem sumiu há 50 dias ainda lembra da loja;
  // quem sumiu há dois anos é quase mensagem fria de novo.
  t('  começando pelos que sumiram há menos tempo',
    alvosReativados.includes('5541977772222') && alvosReativados.includes('5541977771111'), alvosReativados.join(','));

  for (const [regra, numero] of [
    ['quem nunca conversou', '5541977774444'],
    ['quem está com atendente', '5541977775555'],
    ['quem sumiu há pouco', '5541977776666'],
    ['quem já foi reativado', '5541977777777'],
  ]) {
    t(`NÃO fala com ${regra}`, !alvosReativados.includes(numero), numero);
  }

  // Marca antes de enviar, mesmo motivo da conferência.
  t('marca quem foi reativado', Boolean(storePV.getContact('5541977772222')?.reativadoEm));

  const textoRe = reativadas[0]?.texto || '';
  // Uma porta aberta, não um anúncio: texto de propaganda é o que faz a pessoa
  // denunciar como spam, e denúncia é o caminho mais rápido para o número cair.
  t('o texto não é propaganda',
    !/promo[çc][ãa]o|desconto|imperd[íi]vel|oferta|[úu]ltima chance|R\$/i.test(textoRe), textoRe);
  t('  nem inventa urgência', !/corre|agora|hoje|acaba|s[óo] hoje/i.test(textoRe), textoRe);
  t('  e não entrega a origem',
    !PROIBIDO.test(textoRe) && !AUTOMACAO.test(textoRe) && !REPASSE.test(textoRe), textoRe);

  Object.assign(cfgPV.posvenda, reativarAntes);

  // ── O menu tem que aceitar o que a pessoa digita ───────────
  //
  // Sete das oito opções pararam de funcionar em produção e ninguém entendeu
  // por quê: o `resolve` exigia SÓ dígitos (`/^\d+$/`), e o cliente copiava o
  // número da lista com o ponto junto ("2."). Só o oitavo, digitado solto,
  // respondia.
  //
  // Da tela dele: o menu está ali, ele responde certo, e o bot devolve o mesmo
  // menu. Nada no log, nenhum erro, nada para investigar.
  bloco('o menu aceita o número do jeito que a pessoa manda');

  const menuMod = require('./src/menu');

  // TODA opção, em TODA forma. Uma por uma, porque foi exatamente uma opção
  // específica que continuou funcionando e escondeu o problema das outras.
  for (let i = 1; i <= menuMod.NODES.main.options.length; i++) {
    const formas = [`${i}`, `${i}.`, `${i})`, ` ${i} `, `${i} -`, `opcao ${i}`, `${i}\u{fe0f}\u{20e3}`];
    const todas = formas.every((f) => menuMod.resolve('main', f) === menuMod.NODES.main.options[i - 1]);
    t(`opção ${i} resolve em todas as formas`, todas,
      formas.filter((f) => !menuMod.resolve('main', f)).map((f) => JSON.stringify(f)).join(' ') || 'todas');
  }

  // E o que NÃO pode virar escolha de menu continua não virando.
  //
  // Nome de jogo pode ser só dígitos ("1080 Snowboarding", "Fifa 23"): casar
  // isso com uma opção mandaria o cliente para um ramo que ele não escolheu.
  for (const solto of ['23', '1080', '1080 Snowboarding', 'fifa 23', '0', '99', '2 3', 'suporte', '']) {
    t(`"${solto || '(vazio)'}" não vira opção`, menuMod.resolve('main', solto) === null,
      menuMod.resolve('main', solto)?.label);
  }

  // ── A lista nativa ──
  //
  // O título de cada linha tem limite de 24 no WhatsApp, e o corte cru
  // produzia "Tenho dúvidas sobre o" e "Pedir um": frases que terminam no meio
  // e parecem defeito.
  const linhas = menuMod.lista('main', '').rows;
  t('a lista tem uma linha por opção', linhas.length === menuMod.NODES.main.options.length,
    String(linhas.length));
  for (const r of linhas) {
    t(`linha ${r.rowId} cabe no limite do WhatsApp`, r.title.length <= 24,
      `${r.title.length}: ${r.title}`);
    // Terminar em preposição ou artigo é a assinatura do corte no meio.
    // A ÚLTIMA PALAVRA, separada por espaço, e não `\b`.
    //
    // Em JavaScript o `\b` só conhece [A-Za-z0-9_], então "ç" conta como
    // separador: "segurança" parecia terminar na palavra "a" e o teste acusava
    // um corte que não existia. Acento e cedilha são o normal aqui.
    const ultima = r.title.split(/\s+/).pop().toLowerCase();
    t(`  e não termina cortada`,
      !['o', 'a', 'os', 'as', 'de', 'da', 'do', 'com', 'que', 'um', 'uma', 'em', 'no', 'na', 'pra', 'para']
        .includes(ultima),
      `termina em "${ultima}"`);
    // Tocar na linha tem que resolver: algumas versões devolvem o TÍTULO em vez
    // do id, e sem isto o cliente toca no menu e recebe o menu de volta.
    t(`  e o título dela resolve`, Boolean(menuMod.resolve('main', r.title)), r.title);
    t(`  o id dela também`, Boolean(menuMod.resolve('main', r.rowId)), r.rowId);
  }

  // ── O caminho inteiro: cada opção faz alguma coisa ─────────
  //
  // Resolver não basta. Uma opção pode resolver e a ação não existir, e o
  // cliente cairia no "não entendi" do mesmo jeito.
  bloco('cada opção do menu faz alguma coisa');

  const handlersM = require('./src/handlers');
  const storeM = require('./src/store');
  const senderM = require('./src/sender');
  const cfgM = require('./src/config');
  const sendMAntes = senderM.send;

  const autoAntesM = cfgM.autoReply;
  cfgM.autoReply = true;
  require('./src/chaves').definir('atendimento', true);

  for (let i = 1; i <= 8; i++) {
    const CLI = `55419000${i}555`;
    storeM.saveContact(CLI, {
      greetedAt: Date.now(), lastSeen: Date.now(), paused: false,
      menuNode: 'main', modoIA: false, aguardandoJogo: false, aguardandoProblema: false,
    });

    const recebidas = [];
    senderM.send = async (para, txt) => { recebidas.push({ para, texto: String(txt) }); };
    try {
      // Com o PONTO, que é a forma que quebrava.
      await handlersM.onIncomingMessage({ from: CLI, text: `${i}.`, pushName: 'Marco' });
    } finally {
      senderM.send = sendMAntes;
    }

    const aoCliente = recebidas.filter((r) => r.para === CLI).map((r) => r.texto).join('\n');
    t(`opção ${i} responde alguma coisa`, aoCliente.trim().length > 0, '(silêncio)');
    // O sintoma exato do defeito: escolher uma opção e receber o menu de volta.
    t(`  e não devolve "não entendi"`,
      !/n[ãa]o entendi|deixa eu te ajudar melhor|te atender mais r[áa]pido/i.test(aoCliente),
      aoCliente.split('\n')[0]);
  }

  cfgM.autoReply = autoAntesM;



  // ── Aviso de venda no grupo da equipe (#staff) ────────────────
  bloco('venda paga vai para o grupo da equipe');
  {
    const GRUPO = '120363000000000001@g.us';
    const handlersG = require('./src/handlers');
    const op = require('./src/ponte/operador');
    const estadoG = require('./src/ponte/estado');
    const vencerPedido = async (n) => {
      enviadas = [];
      pedidoFalso = pedido({ order_number: n });
      await vendas.onEvento({ event: 'order.paid', data: { order_number: n } });
    };

    // Sem grupo: privado, como sempre.
    await vencerPedido('ped-g0');
    t('sem grupo, o aviso vai ao operador', enviadas.some((e) => e.para === OP && /Venda paga/.test(e.texto)));

    // #staff de quem NÃO é operador, dentro do grupo: ignorado.
    const intruso = await handlersG.onGrupoComando({ grupo: GRUPO, remetentes: ['5511900001111@s.whatsapp.net'], texto: '#staff' });
    t('#staff de não-operador é ignorado', intruso === false && !estadoG.dados.grupoVendas);
    const outroTexto = await handlersG.onGrupoComando({ grupo: GRUPO, remetentes: [OP + '@s.whatsapp.net'], texto: 'oi pessoal' });
    t('conversa comum no grupo não é tratada', outroTexto === false);

    // Operador manda #staff no grupo (remetente em participant).
    enviadas = [];
    const ok = await handlersG.onGrupoComando({ grupo: GRUPO, remetentes: [OP + '@s.whatsapp.net'], texto: '#staff' });
    t('#staff do operador no grupo registra', ok === true && estadoG.dados.grupoVendas === GRUPO);
    t('  e confirma no próprio grupo', enviadas.some((e) => e.para === GRUPO && /neste grupo/.test(e.texto)));

    await vencerPedido('ped-g1');
    t('venda vai para o grupo', enviadas.some((e) => e.para === GRUPO && /Venda paga/.test(e.texto)));
    t('  e não duplica no privado', !enviadas.some((e) => e.para === OP && /Venda paga/.test(e.texto)));
    t('  cliente continua recebendo a confirmação', enviadas.some((e) => e.para === CLI));

    // Grupo falha: cai no privado.
    const sendOk = sender.send;
    sender.send = async (para, texto, opts = {}) => {
      if (para === GRUPO) throw new Error('bot fora do grupo');
      return sendOk(para, texto, opts);
    };
    await vencerPedido('ped-g2');
    sender.send = sendOk;
    t('grupo falhou: o aviso vai ao privado', enviadas.some((e) => e.para === OP && /Venda paga/.test(e.texto)));

    // #staff off.
    await op.executar('#staff off', OP);
    await vencerPedido('ped-g3');
    t('#staff off volta ao privado', enviadas.some((e) => e.para === OP && /Venda paga/.test(e.texto)) &&
      !enviadas.some((e) => e.para === GRUPO));

    // Por nome (Evolution) quando nada foi registrado.
    require('./src/config').evolution.apiKey = 'x';
    require('./src/evolution').fetchAllGroups = async () => [
      { id: '1@g.us', subject: 'Outro' }, { id: GRUPO, subject: 'Phaze Games - STAFF' },
    ];
    await op.executar('#staff auto', OP);
    await vencerPedido('ped-g4');
    t('sem registro, acha o grupo pelo nome', enviadas.some((e) => e.para === GRUPO && /Venda paga/.test(e.texto)));
    await op.executar('#staff off', OP);
  }

  // ── Resumo do dia ─────────────────────────────────────────────
  bloco('resumo do dia');
  {
    const GRUPO = '120363000000000002@g.us';
    const GRUPO_OFICIAL = '120363000000000099@g.us';
    const resumo = require('./src/resumo');
    const op = require('./src/ponte/operador');
    const evo = require('./src/evolution');
    const cfgC = require('./src/config').community;
    cfgC.groupJid = GRUPO_OFICIAL;
    let membros = 100;
    evo.contarParticipantes = async () => membros;

    const pagar = async (n, total) => {
      pedidoFalso = pedido({ order_number: n, total });
      await vendas.onEvento({ event: 'order.paid', data: { order_number: n } });
    };
    const hoje = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const as = (h) => Date.parse(`${hoje()}T${h}:00-03:00`);
    const qtdDe = (txt) => Number((txt.match(/Vendas: \*(\d+)\*/) || [])[1]);
    const antes = qtdDe((await resumo.montar()).texto);

    await pagar('ped-r1', 100);
    await pagar('ped-r1', 100); // webhook repetido: não conta duas vezes
    await pagar('ped-r2', 50.5);
    const cheio = (await resumo.montar()).texto;
    t('conta as vendas pagas do dia, uma vez por pedido', qtdDe(cheio) === antes + 2, cheio.split('\n')[2]);
    t('  e soma o valor em reais', /R\$ [\d.]+,\d\d\)/.test(cheio));

    // Membros: diferença para o retrato anterior.
    resumo._estado().retrato = { n: 92, em: Date.now() - 24 * 3600 * 1000 };
    t('membros novos = diferença para o retrato de ontem', /Membros novos no grupo: \*\+8\*/.test((await resumo.montar()).texto));
    resumo._estado().retrato = { n: 103, em: Date.now() - 24 * 3600 * 1000 };
    t('  saldo negativo aparece com sinal', /\*-3\*/.test((await resumo.montar()).texto));
    membros = null;
    t('  sem dado da Evolution: diz "sem dados"', /sem dados/.test((await resumo.montar()).texto));
    membros = 100;
    resumo._estado().retrato = { n: 92, em: Date.now() - 24 * 3600 * 1000 };

    // Quando sai.
    vendas.definirGrupoVendas(GRUPO);
    enviadas = [];
    // O minuto do envio muda todo dia (base 23h +-30 min, gravado): o teste lê
    // o horario do dia em vez de supor 23:05.
    const quandoR = resumo.horarioDoDia(hoje());
    const noMinuto = (m) => as('00:00') + m * 60000;
    t('o horário do dia fica entre 22:30 e 23:30', quandoR >= 22 * 60 + 30 && quandoR <= 23 * 60 + 30, String(quandoR));
    t('antes da hora não sai', (await resumo.tick(as('22:00'))) === false && (await resumo.tick(noMinuto(quandoR - 1))) === false && enviadas.length === 0);
    t('na hora, sai', (await resumo.tick(noMinuto(quandoR))) === true);
    const env = enviadas.filter((e) => e.para === GRUPO && /Resumo do dia/.test(e.texto));
    t('  vai para o grupo da equipe', env.length === 1);
    t('  traz membros, vendas e rodapé', /\*\+8\*/.test(env[0]?.texto) && /Vendas: \*/.test(env[0]?.texto) && /Bom descanso/.test(env[0]?.texto));
    t('  segunda volta no mesmo dia não repete', (await resumo.tick(as('23:58'))) === false && enviadas.length === 1);
    resumo._recarregar(); // "reinício": o estado vem do disco
    t('  nem depois de reiniciar', (await resumo.tick(as('23:59'))) === false && enviadas.length === 1);
    t('  e o retrato de hoje virou a base de amanhã', resumo._estado().retrato.n === 100);

    // Sem grupo da equipe: cai no privado do operador. Dia seguinte.
    vendas.definirGrupoVendas('off');
    enviadas = [];
    const amanha = as('23:59') + 24 * 3600 * 1000;
    t('no dia seguinte sai de novo', (await resumo.tick(amanha)) === true);
    t('  sem grupo, vai ao privado do operador', enviadas.some((e) => e.para === OP && /Resumo do dia/.test(e.texto)));

    // Desligado.
    process.env.RESUMO_LIGADO = 'false';
    enviadas = [];
    t('RESUMO_LIGADO=false não envia', (await resumo.tick(amanha + 24 * 3600 * 1000)) === false && enviadas.length === 0);
    delete process.env.RESUMO_LIGADO;

    // #resumo: parcial, no privado, sem gastar o envio da noite.
    const ultimo = resumo._estado().ultimoEnvio;
    t('#resumo é reconhecido como comando do operador', op.ehComando(OP, '#resumo') === true);
    const parc = await op.executar('#resumo', OP);
    t('#resumo devolve o parcial', /Resumo parcial/.test(parc) && /Vendas: \*\d+\*/.test(parc));
    t('  e não marca o dia como enviado', resumo._estado().ultimoEnvio === ultimo);
  }

  // ── Bom dia e boa noite do grupo ──────────────────────────────
  bloco('bom dia e boa noite: variações');
  {
    const saud = require('./src/saudacoes');
    const comunidade = require('./src/community');
    const cfgC = require('./src/config').community;
    t('pelo menos 20 bom dia', saud.DIA.length >= 20, String(saud.DIA.length));
    t('pelo menos 20 boa noite', saud.NOITE.length >= 20, String(saud.NOITE.length));
    t('sem texto repetido na lista', new Set(saud.DIA).size === saud.DIA.length && new Set(saud.NOITE).size === saud.NOITE.length);
    t('todos passam pela peneira (vocabulário, tamanho, link)',
      [...saud.DIA, ...saud.NOITE].every((x) => comunidade.saudacaoAprovada(x)));
    t('todo bom dia diz bom dia; toda boa noite diz boa noite',
      saud.DIA.every((x) => /bom dia|acordou/i.test(x)) && saud.NOITE.every((x) => /boa noite/i.test(x)));

    // Emoji com gosto: o dono quer de 3 a 5 por mensagem (sem graça com pouco),
    // mas sem emoji como separador de frase nem no começo de toda linha.
    const nEmoji = (x) => (String(x).match(/\p{Extended_Pictographic}/gu) || []).length;
    const separador = (x) => /[\p{L}\p{N}] *\p{Extended_Pictographic}️? *\p{L}/u.test(x);
    const todas = [...saud.DIA, ...saud.NOITE];
    t('toda saudação tem de 3 a 6 emojis', todas.every((x) => nEmoji(x) >= 3 && nEmoji(x) <= 6),
      todas.filter((x) => nEmoji(x) < 3 || nEmoji(x) > 6)[0]);
    t('  e nenhum emoji serve de separador no meio da frase', todas.every((x) => !separador(x)));
    t('  e emoji só no fim da linha, nunca seguido de texto', todas.every((x) => x.split('\n').every((l) => !/\p{Extended_Pictographic}\uFE0F? *[\p{L}\p{N}]/u.test(l))));
    t('  e nenhuma linha começa com emoji', todas.every((x) => x.split('\n').every((l) => !/^\p{Extended_Pictographic}/u.test(l))));
    t('  e as saudações têm parágrafo', todas.every((x) => x.includes('\n\n')));
    t('  e não usam sempre os mesmos emojis', new Set(todas.join('').match(/\p{Extended_Pictographic}/gu)).size >= 15);
    {
      const T = comunidade.TEXTOS;
      t('nenhuma variação de texto de post passa de 2 emojis', Object.values(T).flat().every((x) => nEmoji(x) <= 2));
      const posv = require('./src/posvenda');
      const vp = [];
      for (let i = 0; i < 40; i++) vp.push(posv.textoDaConferencia('Maria Silva'), posv.textoDeReativacao('Maria Silva'), posv.textoDaConferencia(''), posv.textoDeReativacao(''));
      t('conferência e reativação do pós-venda têm de 3 a 6 emojis, sem separador',
        vp.every((x) => nEmoji(x) >= 3 && nEmoji(x) <= 6 && !separador(x)), vp.find((x) => nEmoji(x) < 3 || nEmoji(x) > 6));
      const nerixE = require('./src/nerix');
      const newsE = require('./src/news');
      const aiE = require('./src/ai');
      const salvoE = { lc: nerixE.listCoupons, lp: nerixE.listProducts, io: newsE.imageOk, ln: newsE.fetchLatestNews, lr: newsE.fetchLatestReviews, tr: aiE.translate };
      nerixE.listCoupons = async () => ({ data: [{ code: 'PHAZE10', is_active: true, is_secret: false, type: 'percentage', value: 10 }] });
      nerixE.listProducts = async () => ({ data: [
        { name: 'Zelda - Mídia Digital - Nintendo Switch', price: 100, promotional_price: 80, sales_count: 9, slug: 'zelda', images: ['a.jpg'] },
        { name: 'Mario - Nintendo Switch', price: 90, sales_count: 5, slug: 'mario', images: ['b.jpg'] },
      ] });
      newsE.imageOk = async () => true;
      aiE.translate = async (x) => x;
      let n = 0;
      newsE.fetchLatestNews = async () => [{ title: 'Novo jogo anunciado', link: `https://x/n${++n}`, source: 'Nintendo', image: 'i.jpg', ts: 1 }];
      newsE.fetchLatestReviews = async () => [{ title: 'Review: Zelda (Switch) - Obra-prima', link: `https://x/r${++n}`, source: 'IGN', image: 'i.jpg', ts: 1 }];
      const amostras = [];
      for (let i = 0; i < 25; i++) {
        const ger = [await comunidade.genCoupon(), await comunidade.genBestSellers(), await comunidade.genAvaliacao(),
          await comunidade.genPromo(), await comunidade.genNews(), await comunidade.genReviews()];
        for (const p of ger) { const tx = typeof p === 'string' ? p : p?.text; if (tx) amostras.push(tx); }
        comunidade._estado().promoRecent = [];
      }
      const ruins = amostras.filter((x) => nEmoji(x) < 3 || nEmoji(x) > 6);
      t('post montado (promo, cupom, mais vendidos, notícia, review, avaliação) tem de 3 a 6 emojis',
        amostras.length >= 100 && ruins.length === 0, ruins[0] || String(amostras.length));
      t('  e nenhum emoji seguido de texto na mesma linha (pós-venda e posts)',
        [...amostras, ...vp].every((x) => x.split('\n').every((l) => !/\p{Extended_Pictographic}\uFE0F? *[\p{L}\p{N}]/u.test(l.replace(/https?:\/\/\S+/g, '')))));
      t('  sem emoji separador e sem linha começando com emoji',
        amostras.every((x) => !separador(x) && x.split('\n').every((l) => !/^\p{Extended_Pictographic}/u.test(l))));
      nerixE.listCoupons = salvoE.lc; nerixE.listProducts = salvoE.lp; newsE.imageOk = salvoE.io;
      newsE.fetchLatestNews = salvoE.ln; newsE.fetchLatestReviews = salvoE.lr; aiE.translate = salvoE.tr;
    }

    // Sorteio: nunca uma das últimas 5.
    let recentes = [];
    let repetiu = false;
    for (let i = 0; i < 400; i++) {
      for (const tipo of ['dia', 'noite']) {
        const { indice } = saud.sortear(tipo, recentes);
        if (recentes.slice(-5).includes(indice)) repetiu = true;
        recentes = [...recentes, indice].slice(-5);
      }
      recentes = [];
    }
    let seq = [];
    for (let i = 0; i < 400; i++) {
      const { indice } = saud.sortear('noite', seq);
      if (seq.slice(-5).includes(indice)) repetiu = true;
      seq = [...seq, indice].slice(-5);
    }
    t('o sorteio não repete nenhuma das últimas 5', !repetiu);

    // Pelo caminho real (saudar): publica no grupo e guarda os índices.
    cfgC.dryRun = false;
    cfgC.groupJid = '120363000000000099@g.us';
    enviadas = [];
    for (let d = 1; d <= 12; d++) await comunidade.saudar('dia', `2030-01-${String(d).padStart(2, '0')}`);
    await comunidade.saudar('dia', '2030-01-12'); // mesmo dia: trava
    const textos = enviadas.map((e) => e.texto);
    t('saudar publica uma por dia', textos.length === 12, String(textos.length));
    t('  e nenhuma igual às 5 anteriores', textos.every((x, i) => !textos.slice(Math.max(0, i - 5), i).includes(x)));
    enviadas = [];
    await comunidade.saudar('noite', '2030-01-01');
    t('boa noite sai com o aviso de que o grupo volta',
      /boa noite/i.test(enviadas[0]?.texto || '') && /volta a abrir/.test(enviadas[0]?.texto || ''));
  }

  // ── Horário variado e texto variado (anti-restrição) ──────────
  //
  // O número foi restringido no pico: anúncios no mesmo minuto, todo dia, com
  // o mesmo texto. Cada item agendado agora sai no base + desvio do dia (gravado),
  // e nenhum trecho fixo repete o último.
  bloco('horario variado, texto variado, sem envio duplo');
  {
    const jit = require('./src/jitter');
    const fsx = require('fs');
    const pathx = require('path');
    const diaN = (n) => new Date(Date.UTC(2031, 0, 1) + n * 86400000).toISOString().slice(0, 10);

    // O sorteio em si: 400 dias seguidos, sempre >= 15 min de diferença e dentro de +-30.
    const mapa = {};
    let okDiff = true; let okFaixa = true; let ant = null; const vistos = new Set();
    for (let n = 0; n < 400; n++) {
      const d = jit.desvioDoDia(mapa, diaN(n));
      if (ant != null && Math.abs(d - ant) < 15) okDiff = false;
      if (Math.abs(d) > 30) okFaixa = false;
      vistos.add(d); ant = d;
    }
    t('desvio de dias seguidos difere em pelo menos 15 min (400 dias)', okDiff);
    t('  e fica dentro de +-30 min', okFaixa);
    t('  e varia de verdade (muitos valores distintos)', vistos.size > 20, String(vistos.size));
    t('  chamar de novo no mesmo dia devolve o mesmo (sem re-sortear)', jit.desvioDoDia(mapa, diaN(399)) === ant);
    t('  o mapa guarda só os últimos dias', Object.keys(mapa).length <= 10);

    // Resumo da equipe: horário do dia gravado em resumo.json.
    const resumoJ = require('./src/resumo');
    const horas = [];
    for (let n = 0; n < 40; n++) horas.push(resumoJ.horarioDoDia(diaN(n)));
    t('resumo: dias seguidos diferem >= 15 min', horas.every((h, i) => i === 0 || Math.abs(h - horas[i - 1]) >= 15), horas.slice(0, 6).join(','));
    t('  e nunca antes de 22:30 nem depois de 23:30', horas.every((h) => h >= 22 * 60 + 30 && h <= 23 * 60 + 30));
    const noDisco = JSON.parse(fsx.readFileSync(pathx.join(process.env.PONTE_DATA_DIR, 'resumo.json'), 'utf8'));
    t('  gravado no disco', noDisco.jitter && noDisco.jitter[diaN(39)] != null);
    const antesR = resumoJ.horarioDoDia(diaN(39));
    resumoJ._recarregar();
    t('  reinício não re-sorteia', resumoJ.horarioDoDia(diaN(39)) === antesR);
    t('  resumo tem 3+ despedidas e 3+ títulos', resumoJ.DESPEDIDAS.length >= 3 && resumoJ.TITULOS.length >= 3);

    // Comunidade: posts e portão.
    let com = require('./src/community');
    const cfgJ = require('./src/config').community;
    const T = com.TEXTOS;
    t('todo trecho fixo tem 3+ variações', Object.entries(T).every(([, l]) => l.length >= 3),
      Object.entries(T).filter(([, l]) => l.length < 3).map(([k]) => k).join(','));
    const politica = require('./src/ponte/politica');
    t('  e nenhuma usa vocabulário proibido', Object.values(T).flat().every((x) => !politica.vocabularioProibido().test(x)));
    let repetiuTexto = false;
    for (const k of Object.keys(T)) {
      let ultimo = null;
      const usados = new Set();
      for (let i = 0; i < 120; i++) {
        const txt = com.varia(k, { url: 'u', de: 'a', por: 'b', off: 'c', code: 'd', link: 'l', h: 9 });
        if (txt === ultimo) repetiuTexto = true;
        usados.add(txt); ultimo = txt;
      }
      if (usados.size < 3) repetiuTexto = true;
    }
    t('a variação nunca repete a última e usa 3+ textos', !repetiuTexto);
    t('  o índice da última fica gravado', com._estado().textoUlt && Object.keys(com._estado().textoUlt).length === Object.keys(T).length);

    const horasP = []; const abre = []; const fecha = [];
    const itemP = { key: 'promo', hour: 13 };
    for (let n = 0; n < 60; n++) {
      horasP.push(com.horarioDoPost(itemP, diaN(n)));
      const h = com.horariosDoPortao(diaN(n)); abre.push(h.abreMin); fecha.push(h.fechaMin);
    }
    const difOk = (a) => a.every((x, i) => i === 0 || Math.abs(x - a[i - 1]) >= 15);
    t('post: dias seguidos diferem >= 15 min', difOk(horasP), horasP.slice(0, 6).join(','));
    t('  abrir e fechar também', difOk(abre) && difOk(fecha));
    t('  post de 13h fica entre 12:30 e 13:30', horasP.every((h) => h >= 12 * 60 + 30 && h <= 13 * 60 + 30));
    t('  abrir não sai antes de 8:30 nem fecha depois de 23:30',
      abre.every((h) => h >= 8 * 60 + 30 && h <= 9 * 60 + 30) && fecha.every((h) => h >= 22 * 60 + 30 && h <= 23 * 60 + 30));

    // Reinício: recarrega o módulo (o estado vem do community.json).
    const antesRe = com.horarioDoPost(itemP, diaN(59));
    delete require.cache[require.resolve('./src/community')];
    com = require('./src/community');
    t('reinício não re-sorteia o horário do post', com.horarioDoPost(itemP, diaN(59)) === antesRe);
    t('  nem o do portão', com.horariosDoPortao(diaN(59)).abreMin === abre[59]);

    // tick de ponta a ponta: sem envio antes da hora, um só na hora, nenhum depois do reinício.
    const nerixJ = require('./src/nerix');
    const chavesJ = require('./src/chaves');
    nerixJ.listCoupons = async () => ({ data: [{ code: 'PHAZE10', is_active: true, is_secret: false, type: 'percentage', value: 10 }] });
    nerixJ.listProducts = async () => ({ data: [{ name: 'Zelda', price: 100, sales_count: 9, slug: 'zelda' }] });
    const salvoJ = {
      enabled: cfgJ.enabled, dry: cfgJ.dryRun, jid: cfgJ.groupJid, port: cfgJ.portaoLigado,
      saud: cfgJ.saudacoesLigadas, sched: cfgJ.schedule, now: Date.now,
    };
    cfgJ.enabled = true; cfgJ.dryRun = false; cfgJ.groupJid = '120363000000000077@g.us';
    cfgJ.portaoLigado = false; cfgJ.saudacoesLigadas = false;
    cfgJ.schedule = [{ key: 'coupon', everyDays: 1, hour: 17 }, { key: 'bestsellers', everyDays: 1, hour: 17 }];
    const dia = '2031-03-10';
    const st = com._estado();
    st.jitter = st.jitter || {};
    st.jitter['post-coupon@17'] = { [dia]: 0 };       // 17:00
    st.jitter['post-bestsellers@17'] = { [dia]: 5 };  // 17:05
    st.slots = {}; st.lastPostAt = {}; st.ultimoPostGrupo = 0;
    const naHora = (hhmm) => Date.parse(`${dia}T${hhmm}:00-03:00`);
    enviadas = [];
    Date.now = () => naHora('16:55');
    await com.tick();
    t('tick antes do horário: nada sai', enviadas.length === 0);
    Date.now = () => naHora('17:02');
    await com.tick();
    t('no horário: sai o cupom, uma vez', enviadas.length === 1 && /PHAZE10/.test(enviadas[0].texto), String(enviadas.length));
    Date.now = () => naHora('17:07');
    await com.tick();
    t('espaçamento: o segundo post (já no horário) espera 20 min', enviadas.length === 1, String(enviadas.length));
    delete require.cache[require.resolve('./src/community')];
    com = require('./src/community');             // reinício do bot
    Date.now = () => naHora('17:12');
    await com.tick();
    t('depois do reinício: o cupom não sai de novo e o espaçamento continua', enviadas.length === 1, String(enviadas.length));
    Date.now = () => naHora('17:30');
    await com.tick();
    t('passados 20 min, sai o outro post', enviadas.length === 2 && /mais vendidos|bombando|queridinhos|mais pedidos/i.test(enviadas[1].texto), enviadas[1]?.texto?.slice(0, 40));
    Date.now = () => naHora('17:50');
    await com.tick();
    t('e depois disso nada se repete no dia', enviadas.length === 2);
    t('  o espaçamento entre os dois foi de 20+ min',
      (() => { const e = com._estado(); return e.lastPostAt['bestsellers@17'] - e.lastPostAt['coupon@17'] >= 20 * 60000; })());

    // Tick depois de fechar: não anuncia.
    cfgJ.portaoLigado = true;
    cfgJ.schedule = [{ key: 'coupon', everyDays: 1, hour: 23 }];
    const st2 = com._estado();
    st2.jitter['post-coupon@23'] = { [dia]: 29 };   // 23:29
    st2.jitter['portao-fecha'] = { [dia]: -30 };    // fecha 22:30
    st2.jitter['portao-abre'] = { [dia]: 0 };
    st2.slots = {}; st2.lastPostAt = {}; st2.ultimoPostGrupo = 0; st2.grupoAberto = false; st2.portaoManualAte = 0;
    const evoJ = require('./src/evolution');
    const portaoSalvo = evoJ.portaoDoGrupo; evoJ.portaoDoGrupo = async () => ({});
    const ligadaSalva = chavesJ.ligada; chavesJ.ligada = () => true;
    enviadas = [];
    Date.now = () => naHora('23:35');
    await com.tick();
    t('grupo fechado pelo horário: não anuncia', enviadas.length === 0, String(enviadas.length));
    chavesJ.ligada = ligadaSalva; evoJ.portaoDoGrupo = portaoSalvo;

    Date.now = salvoJ.now;
    cfgJ.enabled = salvoJ.enabled; cfgJ.dryRun = salvoJ.dry; cfgJ.groupJid = salvoJ.jid;
    cfgJ.portaoLigado = salvoJ.port; cfgJ.saudacoesLigadas = salvoJ.saud; cfgJ.schedule = salvoJ.sched;

    // Posvenda: variações sem repetir em sequência.
    const pv = require('./src/posvenda');
    const confs = new Set(); const reats = new Set(); let seqIgual = false;
    let uc = null; let ur = null;
    for (let i = 0; i < 60; i++) {
      const c = pv.textoDaConferencia('Ana Silva'); const r = pv.textoDeReativacao('Ana Silva');
      if (c === uc || r === ur) seqIgual = true;
      confs.add(c); reats.add(r); uc = c; ur = r;
    }
    t('posvenda: 3 variações de conferência e de reativação, sem repetir em sequência',
      confs.size >= 3 && reats.size >= 3 && !seqIgual, `${confs.size}/${reats.size}`);
  }

  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'todos os testes passaram'));
  process.exit(falhas ? 1 : 0);
})();
