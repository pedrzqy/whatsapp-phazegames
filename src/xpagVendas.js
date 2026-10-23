'use strict';

/**
 * VENDAS DA XPAG — o que fazer quando um pagamento em MXN (SPEI/CLABE, OXXO)
 * e confirmado FORA da Nerix.
 *
 * A Nerix nao sabe dessas vendas, entao nenhum order.paid chega: sem este
 * arquivo o bot nunca avisa a equipe, o resumo do dia nao conta e o #vendas
 * nao mostra. Aqui a venda e registrada no MESMO vendas.json (com
 * moeda: 'MXN' e origem: 'xpag'), avisada no grupo da equipe e, quando da para
 * ligar a venda a um telefone, confirmada ao cliente.
 *
 * TRES TRAVAS:
 *
 *  1. SO O ESTADO REAL CONTA. A XPag nao assina o webhook. Quem chama aqui
 *     (server.js, #xpag) ja leu o estado no /consult-transaction; este arquivo
 *     ainda recusa o que nao for cash in "confirmed".
 *  2. UMA VEZ SO. A chave e o e2e (unico por pagamento) ou o transaction_id, e
 *     TODOS os identificadores ficam guardados: webhook repetido, webhook +
 *     #xpag registrar e o codigo digitado pelo operador batem no mesmo
 *     registro e nao contam em dobro.
 *  3. TELEFONE NAO SE ADIVINHA. O telefone vem do pagador (se a XPag o der) ou
 *     do pedido da loja cujo codigo foi usado como external_id E cujo valor
 *     bate. Sem isso, so a equipe e avisada, com os dados, para falar na mao.
 *
 * O bot NAO entrega nada nessas vendas: as chaves vem da Nerix. O aviso diz
 * "entregar manualmente" de forma explicita.
 */

const xpag = require('./xpag');
const moeda = require('./moeda');
const telefones = require('./telefone');
const { idiomaDoTelefone } = require('./idioma');
const lembretes = require('./xpagLembretes');

const minus = (s) => String(s || '').trim();

const PAIS_DA_MOEDA = { MXN: 'MX', COP: 'CO', CLP: 'CL' };

/** CURP/RFC/CPF nunca saem inteiros: so os 4 ultimos. */
function mascarar(doc) {
  const d = minus(doc);
  if (!d) return '';
  return d.length <= 4 ? '****' : `****${d.slice(-4)}`;
}

/**
 * Status que vale como pago. A doc da XPag manda creditar COP e CLP em
 * "confirmed" E "completed"; no Mexico so "confirmed" vale (nao muda nada).
 */
function statusPago(status, moedaCod) {
  if (status === 'confirmed') return true;
  const m = minus(moedaCod).toUpperCase();
  return status === 'completed' && (m === 'COP' || m === 'CLP');
}

/** O estado real e um recebimento confirmado? */
function confirmada(tx, moedaCod = null) {
  return !!tx && statusPago(tx.status, tx.moeda || moedaCod) && (!tx.tipo || tx.tipo === 'cashin');
}

/** Chave unica da venda: e2e (por pagamento) > transacao > external_id. */
function chaveDe(tx) {
  const id = tx.estatica ? minus(tx.e2e) : minus(tx.e2e) || minus(tx.transacao) || minus(tx.externalId);
  return id ? `xpag:${id}` : null;
}

function idsDe(tx, extra = []) {
  // O external_id NAO entra: e do pedido, e uma cobranca nova com o mesmo pode
  // ser outro pagamento. Chave/CLABE de valor aberto: transaction_id e external_id sao os MESMOS em
  // todos os pagamentos daquela chave (a doc mostra transaction_id = external_id).
  // So o e2e identifica UM pagamento; usar os outros colapsaria o segundo
  // pagamento da mesma CLABE no primeiro.
  if (tx.estatica) return [tx.e2e].filter(Boolean);
  return [tx.transacao, tx.e2e, ...extra].filter(Boolean);
}

/** Data da venda: a da API so no registro manual (backfill); no webhook e agora. */
function quandoDe(tx, usarDataDaApi) {
  if (usarDataDaApi && tx.em) {
    const ms = new Date(tx.em).getTime();
    if (Number.isFinite(ms) && ms <= Date.now() + 60_000 && ms > Date.now() - 400 * 24 * 3600 * 1000) return ms;
  }
  return Date.now();
}

/**
 * Telefone e dados do cliente, sem chute.
 * Devolve { numero, nome, itens, pedido, motivo }.
 */
async function vincularCliente(tx, extra = null) {
  const out = { numero: null, nome: extra?.nome || tx.pagador?.nome || '', itens: [], pedido: null, motivo: '' };

  // 1. Pedido da loja cujo codigo foi usado como external_id e cujo valor bate.
  if (tx.externalId) {
    try {
      const nerix = require('./nerix');
      const resp = await nerix.getOrder(tx.externalId);
      const cru = resp?.data || resp;
      const total = Number(cru?.total ?? cru?.amount);
      if (cru && Number.isFinite(total) && Math.abs(total - tx.valor) < 0.01) {
        const f = require('./tools').formatOrder(cru);
        if (!f.pago) {
          const n = require('./vendas').numeroDoCru(cru);
          if (n) out.numero = n;
          out.pedido = f.codigo || tx.externalId;
          out.itens = f.itens || [];
          out.nome = out.nome || cru.customer_name || cru.customer?.name || '';
        } else {
          out.motivo = `o pedido ${tx.externalId} da loja ja consta como pago por outro meio`;
        }
      } else if (cru) {
        out.motivo = `o pedido ${tx.externalId} da loja tem outro valor, nao vinculei`;
      }
    } catch { /* external_id que nao e pedido da loja: segue sem vinculo */ }
  }

  // 2. Dados que o phaze-xpag guardou do cliente no checkout (repasse).
  // A pista de pais vem da MOEDA: um colombiano digita 3001234567, e com a
  // pista errada (MX) isso virava o 52300... de um desconhecido.
  const pais = PAIS_DA_MOEDA[minus(tx.moeda).toUpperCase()] || 'MX';
  if (!out.numero && extra?.telefone) {
    out.numero = telefones.paraWhatsApp(extra.telefone, pais);
  }
  if (!out.itens.length && extra?.itens?.length) out.itens = extra.itens;

  // 3. Telefone que o proprio pagador deixou na XPag (se a API devolver).
  if (!out.numero && tx.pagador?.telefone) {
    out.numero = telefones.paraWhatsApp(tx.pagador.telefone, pais);
  }
  return out;
}

// A mensagem ao cliente segue o idioma do DDI do telefone (idioma.js):
// espanhol para Mexico, Colombia, Chile e demais paises hispanofalantes,
// portugues para o resto. A equipe continua lendo portugues (textoParaEquipe).
function textoAoCliente({ nome, valor, moedaCod, pedido, numero }) {
  const primeiro = nome ? String(nome).trim().split(/\s+/)[0] : '';
  if (idiomaDoTelefone(numero) === 'es') {
    return [
      `${primeiro ? `${primeiro}, ¡p` : '¡P'}ago confirmado! ✅`,
      '',
      `Recibimos tu pago de *${lembretes.dinheiro(valor, moedaCod, 'es')}*${pedido ? ` (pedido *${pedido}*)` : ''}.`,
      '',
      'Ya estamos preparando tu entrega y te avisamos por aquí en cuanto esté lista 👍',
    ].join('\n');
  }
  return [
    `${primeiro ? `${primeiro}, p` : 'P'}agamento confirmado ✅`,
    '',
    `Recebemos seu pagamento de *${moeda.formatar(valor, moedaCod)}*${pedido ? ` (pedido *${pedido}*)` : ''}.`,
    '',
    'Já estamos preparando sua entrega e te mandamos aqui assim que ficar pronta 👍',
  ].join('\n');
}

function textoParaEquipe({ tx, vinculo, numero, avisado, chave, manual, cupom }) {
  const linhas = [`💰 *Venda paga (${moeda.paisDaMoeda(tx.moeda)})* — ${moeda.formatar(tx.valor, tx.moeda)}${tx.metodo ? ` · ${tx.metodo}` : ''}`, ''];
  if (vinculo.nome) linhas.push(`*${vinculo.nome}*`);
  if (numero) linhas.push(`+${numero}`);
  if (tx.pagador?.email) linhas.push(tx.pagador.email);
  if (tx.pagador?.documento) linhas.push(`doc ${mascarar(tx.pagador.documento)}`);
  if (vinculo.itens.length) {
    linhas.push('');
    for (const i of vinculo.itens) linhas.push(`• ${i.nome}${i.quantidade > 1 ? ` (${i.quantidade}x)` : ''}`);
  }
  if (cupom) {
    const partes = [];
    if (cupom.tipo === 'percentual' && cupom.valor) partes.push(`${cupom.valor}%`);
    if (cupom.descontoBRL) partes.push(`-${moeda.formatar(cupom.descontoBRL, 'BRL')} no pedido`);
    linhas.push('', `🏷️ Cupom *${cupom.codigo}*${partes.length ? ` (${partes.join(', ')})` : ''}`);
  }
  linhas.push('', '⚠️ *Entregar manualmente* — venda pela XPag, o bot não envia chave nesta venda.');
  if (avisado) linhas.push('✅ Cliente avisado do pagamento no WhatsApp.');
  else if (numero) linhas.push('⚠️ Não consegui avisar o cliente — fale com ele.');
  else linhas.push('⚠️ *Sem telefone vinculado* — o cliente não foi avisado, fale com ele na mão.');
  if (vinculo.pedido) linhas.push(`Pedido da loja: ${vinculo.pedido} (segue pendente lá, dê baixa na mão).`);
  else if (vinculo.motivo) linhas.push(`_${vinculo.motivo}_`);
  if (manual) linhas.push('_Registrada pelo #xpag._');
  linhas.push('', `_XPag ${chave.replace(/^xpag:/, '')}_`);
  return linhas.join('\n');
}

/**
 * Registra UM recebimento confirmado, avisa a equipe e (se der) o cliente.
 * `tx` e o resultado de xpag.consultar / lerTransacao (estado REAL).
 * Devolve { ok, novo, chave, motivo }.
 */
async function registrar(tx, { fallbackMoeda = null, codigoDigitado = null, manual = false, extra = null } = {}) {
  if (!confirmada(tx, fallbackMoeda)) return { ok: false, motivo: `status ${tx?.status || 'desconhecido'}: so recebimento confirmado vira venda` };
  const moedaCod = (tx.moeda || fallbackMoeda || '').toUpperCase();
  if (!moedaCod) return { ok: false, motivo: 'a XPag nao informou a moeda' };
  if (!Number.isFinite(tx.valor) || tx.valor <= 0) return { ok: false, motivo: 'a XPag nao informou o valor' };
  const chave = chaveDe(tx);
  if (!chave) return { ok: false, motivo: 'sem e2e, transaction_id nem external_id para identificar a venda' };

  // Pago confirmado: para os lembretes desta cobranca (por qualquer caminho que
  // a confirmacao chegue: repasse, webhook cru ou #xpag registrar).
  if (tx.externalId) lembretes.encerrar(tx.externalId, 'paga');

  const vendas = require('./vendas');
  const ids = idsDe(tx, [codigoDigitado]);
  const dup = vendas.acharVendaExterna(ids);
  if (dup) return { ok: true, novo: false, chave: dup };

  // Grava ANTES de avisar (mesma regra do marcar): na duvida, perde-se um
  // aviso, nunca se conta a venda duas vezes.
  const t = { ...tx, moeda: moedaCod };
  const r = vendas.registrarVendaExterna({
    chave,
    ids,
    valor: t.valor,
    moeda: moedaCod,
    quando: quandoDe(t, manual),
    extras: {
      externalId: t.externalId || undefined,
      pagador: t.pagador?.nome || undefined,
      documento: t.pagador?.documento ? mascarar(t.pagador.documento) : undefined,
    },
  });
  if (!r.novo) return { ok: true, novo: false, chave: r.chave };

  let vinculo = { numero: null, nome: extra?.nome || t.pagador?.nome || '', itens: extra?.itens || [], pedido: null, motivo: '' };
  try { vinculo = await vincularCliente(t, extra); } catch (e) { console.warn('[xpag] vinculo falhou:', e.message); }

  let avisado = false;
  if (vinculo.numero) {
    try {
      await require('./sender').send(vinculo.numero, textoAoCliente({ nome: vinculo.nome, valor: t.valor, moedaCod, pedido: vinculo.pedido, numero: vinculo.numero }));
      avisado = true;
    } catch (e) {
      console.warn('[xpag] nao consegui avisar o cliente:', e.message);
    }
  }
  const reg = vendas._dados().pedidos[r.chave];
  if (reg) {
    if (vinculo.numero) reg.telefone = vinculo.numero;
    if (avisado) reg.avisadoCliente = Date.now();
    if (vinculo.pedido) reg.pedidoLoja = vinculo.pedido;
    vendas.persistir();
  }

  try {
    await vendas.avisarVenda(textoParaEquipe({ tx: extra?.email && !t.pagador?.email ? { ...t, pagador: { ...t.pagador, email: extra.email } } : t, vinculo, numero: vinculo.numero, avisado, chave: r.chave, manual, cupom: extra?.cupom || null }));
  } catch (e) {
    console.warn('[xpag] nao consegui avisar a equipe:', e.message);
  }
  console.log(`[xpag] venda registrada ${r.chave}: ${moeda.formatar(t.valor, moedaCod)} (cliente ${avisado ? 'avisado' : 'NAO avisado'})`);
  return { ok: true, novo: true, chave: r.chave, avisado };
}

/**
 * Chamado pelo webhook DEPOIS de reler o estado real.
 * `evento` = lerWebhook(corpo); `real` = consultar(...) com ok e confirmed.
 */
async function processarWebhook(evento, real, extra = null) {
  let tx = real;
  if (Array.isArray(real.pagamentos) && real.pagamentos.length) {
    // CLABE de valor aberto: a consulta traz a lista; vale o pagamento do aviso.
    tx = real.pagamentos.find((p) => p.e2e && p.e2e === evento.e2e) || null;
    if (!tx) return { ok: false, motivo: 'o pagamento do aviso nao esta na lista da consulta' };
  }
  return registrar(
    { ...tx, externalId: tx.externalId || evento.externalId, e2e: tx.e2e || evento.e2e, transacao: tx.transacao || evento.transacao },
    { fallbackMoeda: evento.moeda, extra },
  );
}

// ── Repasse do phaze-xpag ─────────────────────────────────────

const textoCurto = (v, n = 80) => minus(v).replace(/\s+/g, ' ').slice(0, n);

/** Itens do repasse: [{nome, quantidade}] (aceita name/qty/quantity). Sem lixo. */
function itensDoRepasse(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((i) => ({
      nome: textoCurto(i?.nome ?? i?.name, 80),
      quantidade: Math.max(1, Math.min(99, Math.floor(Number(i?.quantidade ?? i?.qty ?? i?.quantity ?? 1)) || 1)),
    }))
    .filter((i) => i.nome)
    .slice(0, 20);
}

/** Cupom que o cliente usou na loja (so para a equipe saber do desconto). */
function cupomDoRepasse(c) {
  if (!c || typeof c !== 'object') return null;
  const codigo = textoCurto(c.codigo, 40).toUpperCase();
  if (!codigo) return null;
  const desc = Number(c.descontoBRL);
  const sub = Number(c.subtotalBRL);
  return {
    codigo,
    tipo: c.tipo === 'fixo' ? 'fixo' : 'percentual',
    valor: Number.isFinite(Number(c.valor)) ? Number(c.valor) : null,
    descontoBRL: Number.isFinite(desc) && desc > 0 ? desc : null,
    subtotalBRL: Number.isFinite(sub) && sub > 0 ? sub : null,
  };
}

/** Dados do cliente no repasse (sem documento: nunca pedimos CURP/RFC aqui). */
function extraDoRepasse(c) {
  const cli = c.cliente && typeof c.cliente === 'object' ? c.cliente : {};
  return {
    nome: textoCurto(cli.nome ?? c.nome),
    email: textoCurto(cli.email ?? c.email, 120),
    telefone: textoCurto(cli.telefone ?? c.telefone, 30),
    itens: itensDoRepasse(c.itens ?? cli.itens),
    cupom: cupomDoRepasse(c.cupom),
  };
}

/**
 * Trata o aviso que o phaze-xpag manda (corpo com `evento`). O chamador ja
 * checou o segredo da URL. Devolve { ok, motivo?, novo? } para o log.
 *
 *  - pago: com credenciais XPag, reconsulta (e2e, depois transacao) e so
 *    registra se confirmed. Sem credenciais, so aceita com
 *    config.xpag.confiarRepasse (padrao true): o repasse vem do nosso backend,
 *    que ja reconsultou, e so chega com o segredo certo. Mesma chave (e2e) do
 *    webhook cru: um nao conta em dobro com o outro.
 *  - disputa / saque_falhou: so alerta a equipe.
 */
async function processarRepasse(corpo) {
  const config = require('./config');
  const c = corpo || {};
  const evento = minus(c.evento).toLowerCase();

  // Defesa em profundidade (a rota ja barra): repasse so vale com o segredo da
  // URL configurado. Sem ele nao ha como saber que veio do phaze-xpag.
  if (!config.webhook.xpagSecret) {
    console.error('[xpag] repasse RECUSADO: XPAG_WEBHOOK_SECRET vazio (qualquer um poderia forjar uma venda).');
    return { ok: false, motivo: 'XPAG_WEBHOOK_SECRET vazio: repasse recusado' };
  }

  if (evento === 'disputa' || evento === 'saque_falhou') {
    const linhas = evento === 'disputa'
      ? ['🚨 *Disputa (MED) na XPag*', `Pedido: ${textoCurto(c.pedido) || '(sem pedido)'}`, c.transacao ? `Transação: ${textoCurto(c.transacao)}` : '', 'Uma entrada já confirmada foi contestada. *Não entregue* se ainda não entregou; veja no painel da XPag.']
      : ['⚠️ *Saque falhou na XPag*', `Pedido: ${textoCurto(c.pedido) || '(sem pedido)'}`, c.motivo ? `Motivo: ${textoCurto(c.motivo, 200)}` : ''];
    console.warn(`[xpag] repasse ${evento}: pedido ${c.pedido || '(vazio)'}`);
    try { await require('./vendas').avisarVenda(linhas.filter(Boolean).join('\n')); }
    catch (e) { console.warn('[xpag] nao consegui avisar a equipe do repasse:', e.message); }
    return { ok: true, alerta: evento };
  }

  // Lembretes de pagamento: a cobranca foi criada / venceu. Nada disto mexe em
  // venda nem em dinheiro; so agenda ou cancela mensagens ao cliente.
  if (evento === 'criada') {
    if (!config.xpag.enabled) return { ok: false, motivo: 'XPAG_ENABLED=false' };
    const r = lembretes.registrarCriada(c);
    return r.ok ? { ...r, lembrete: 'criada' } : r;
  }
  if (evento === 'expirada') {
    const pedido = minus(c.pedido);
    if (!pedido) return { ok: false, motivo: 'expirada sem pedido' };
    lembretes.encerrar(pedido, 'expirada');
    return { ok: true, lembrete: 'expirada' };
  }

  if (evento !== 'pago') return { ok: false, motivo: `evento "${evento || '(vazio)'}" desconhecido` };

  const e2e = minus(c.e2e);
  const transacao = minus(c.transacao);
  const pedido = minus(c.pedido);
  const moedaCod = minus(c.moeda).toUpperCase();
  const valor = Number(c.valor);
  const extra = extraDoRepasse(c);
  if (!e2e && !transacao) return { ok: false, motivo: 'repasse sem e2e nem transacao' };

  const evt = { e2e: e2e || null, transacao: transacao || null, externalId: pedido || null, moeda: moedaCod || null, estatica: !!c.clabeAberta };

  if (xpag.configurado()) {
    let real = null;
    if (e2e) real = await xpag.consultar({ e2e });
    if ((!real || !real.ok) && transacao) real = await xpag.consultar({ transacao, e2e: e2e || undefined });
    if (!real || !real.ok) return { ok: false, motivo: `nao consegui conferir na XPag: ${real?.codigo || 'sem_codigo'}` };
    if (!statusPago(real.status, real.moeda || moedaCod) && !(Array.isArray(real.pagamentos) && real.pagamentos.some((p) => statusPago(p.status, real.moeda || moedaCod) && p.e2e === e2e))) {
      return { ok: false, motivo: `aviso divergente: o repasse dizia pago e a consulta diz ${real.status}` };
    }
    if (Number.isFinite(valor) && Number.isFinite(real.valor) && Math.abs(valor - real.valor) > 0.01) {
      console.warn(`[xpag] repasse diz ${valor} e a XPag diz ${real.valor} (pedido ${pedido}); vale a XPag.`);
    }
    return processarWebhook(evt, real, extra);
  }

  if (!config.xpag.enabled) return { ok: false, motivo: 'XPAG_ENABLED=false' };
  if (!config.xpag.confiarRepasse) return { ok: false, motivo: 'sem credenciais XPag e XPAG_CONFIAR_REPASSE=false' };
  if (!e2e) return { ok: false, motivo: 'sem credenciais para conferir e o repasse nao traz e2e' };
  console.log(`[xpag] repasse aceito sem reconsulta (XPAG_CONFIAR_REPASSE; o phaze-xpag ja conferiu): ${pedido || e2e}`);
  return registrar(
    { status: 'confirmed', tipo: 'cashin', valor, moeda: moedaCod, e2e, transacao: transacao || null, externalId: pedido || null, estatica: !!c.clabeAberta, pagador: null },
    { fallbackMoeda: moedaCod, extra },
  );
}


/**
 * Consulta um codigo digitado pelo operador. O codigo pode ser o e2e (no SPEI
 * e a "clave de rastreo", ex.: MBAN01002610210063633699), o transaction_id ou
 * o nosso external_id: tenta nessa ordem ate a XPag achar.
 */
async function consultarCodigo(codigo) {
  const c = minus(codigo);
  const tentativas = [{ e2e: c }, { transacao: c }, { requisicao: c }, { externalId: c }];
  let ultimo = null;
  for (const params of tentativas) {
    const r = await xpag.consultar(params);
    if (r.ok) {
      const lista = Array.isArray(r.pagamentos) && r.pagamentos.length ? r.pagamentos : [r];
      return { ok: true, por: Object.keys(params)[0], txs: lista, real: r };
    }
    ultimo = r;
    if (r.codigo === 'nao_configurado') break;
  }
  return { ok: false, erro: ultimo };
}

/** Comando #xpag. Devolve o texto da resposta. */
async function comando(args) {
  const vendas = require('./vendas');
  const partes = minus(args).split(/\s+/).filter(Boolean);

  if (!xpag.configurado()) {
    return `💳 *XPag desligada*: ${xpag.ligado() ? 'faltam XPAG_CLIENT_ID e XPAG_CLIENT_SECRET no Environment.' : 'XPAG_ENABLED=false.'}`;
  }
  if (!partes.length) {
    return '💳 *#xpag* — *#xpag hoje* lista as vendas XPag de hoje · *#xpag <código>* consulta (e2e, transaction_id ou external_id) · *#xpag <código> registrar* lança como venda se estiver confirmada';
  }

  if (/^(hoje|today)$/i.test(partes[0])) {
    const dia = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const lista = vendas.vendasExternasDoDia(dia);
    if (!lista.length) {
      return '💳 Nenhuma venda XPag registrada hoje.\n_Não conheço uma listagem na API da XPag; isto mostra o que o bot registrou. Para lançar uma venda: *#xpag <código> registrar*._';
    }
    const totais = {};
    const linhas = ['💳 *Vendas XPag de hoje*', ''];
    for (const v of lista) {
      moeda.somar(totais, v.valor, v.moeda);
      linhas.push(`• ${moeda.formatar(v.valor, v.moeda)}${v.pagador ? ` — ${v.pagador}` : ''} (${v.chave.replace('xpag:', '')})`);
    }
    linhas.push('', `Total: *${moeda.formatarTotais(totais)}*`);
    return linhas.join('\n');
  }

  const codigo = partes[0];
  const resto = partes.slice(1);
  const registrarIt = resto.some((p) => /^registrar$/i.test(p));
  const moedaInformada = (resto.find((p) => /^[A-Za-z]{3}$/.test(p) && !/^registrar$/i.test(p)) || '').toUpperCase();

  const c = await consultarCodigo(codigo);
  if (!c.ok) return `💳 Não achei *${codigo}* na XPag (${c.erro?.codigo || 'sem_codigo'}).`;

  const saidas = [];
  for (const tx of c.txs) {
    const moedaCod = (tx.moeda || moedaInformada || '').toUpperCase();
    const ja = vendas.acharVendaExterna(idsDe(tx, [codigo]));
    const linhas = [
      `💳 *XPag* — ${tx.status || 'sem status'}`,
      `Valor: *${tx.valor != null ? (moedaCod ? moeda.formatar(tx.valor, moedaCod) : `${tx.valor} (moeda não informada)`) : 'não informado'}*`,
    ];
    if (tx.pagador?.nome) linhas.push(`Pagador: ${tx.pagador.nome}${tx.pagador.documento ? ` (${mascarar(tx.pagador.documento)})` : ''}`);
    if (tx.em) linhas.push(`Data: ${tx.em}`);
    if (tx.externalId) linhas.push(`external_id: ${tx.externalId}`);
    linhas.push(`Já registrada no bot: *${ja ? 'sim' : 'não'}*`);

    if (registrarIt) {
      if (ja) linhas.push('_Já estava registrada, nada foi feito._');
      else {
        const r = await registrar({ ...tx, moeda: moedaCod || null }, { codigoDigitado: codigo, manual: true });
        if (!r.ok) linhas.push(`⚠️ Não registrei: ${r.motivo}${/moeda/.test(r.motivo) ? ` (use: #xpag ${codigo} registrar MXN)` : ''}`);
        else linhas.push(r.novo ? '✅ Registrada como venda (a equipe foi avisada no grupo).' : '_Já estava registrada._');
      }
    } else if (!ja && confirmada(tx)) {
      linhas.push(`_Para lançar: *#xpag ${codigo} registrar*_`);
    }
    saidas.push(linhas.join('\n'));
  }
  return saidas.join('\n\n');
}

module.exports = { registrar, processarWebhook, processarRepasse, consultarCodigo, comando, confirmada, statusPago, mascarar, chaveDe, textoAoCliente };
