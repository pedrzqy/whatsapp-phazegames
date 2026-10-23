'use strict';

/**
 * LEMBRETES DE PAGAMENTO DA XPAG — o equivalente do lembrete de Pix da Nerix
 * (vendas.js, lembrarPixPendente) para as cobrancas que o phaze-xpag cria fora
 * da Nerix: SPEI/OXXO (Mexico, MXN), Nequi QR/Bre-B (Colombia, COP) e checkout
 * hospedado (Chile, CLP).
 *
 * COMO FUNCIONA
 *   1. O phaze-xpag manda {evento:'criada', ...} quando o cliente gera a
 *      cobranca (mesmo endpoint e mesmo segredo do repasse de 'pago').
 *      xpagVendas.processarRepasse chama registrarCriada() aqui.
 *   2. A cobranca fica em data/xpag-pendentes.json (volume: sobrevive a deploy)
 *      com um calendario de passos, que depende do metodo (ver passosDe).
 *   3. Uma varredura por minuto manda o passo que venceu, se for hora civil NO
 *      FUSO DO CLIENTE (9h-21h), e o calendario ainda valer.
 *   4. 'pago' (registrar em xpagVendas), 'expirada' ou uma cobranca mais nova da
 *      mesma pessoa encerram o calendario.
 *
 * REGRAS (cada uma por um motivo, as mesmas do lembrete de Pix):
 *  - Marca ANTES de enviar: falha de envio vira lembrete perdido, nunca repetido.
 *  - Uma mensagem por pessoa por vez: cobranca nova substitui a antiga.
 *  - No maximo 3 mensagens por cobranca, com 2h de intervalo minimo (exceto
 *    Colombia, onde o codigo vence em minutos).
 *  - Sem telefone vinculado: NADA sai para o cliente (e a equipe nao e
 *    incomodada; o resumo do dia so conta quantas estao em aberto).
 *  - Conversa assumida por atendente (contact.paused): nao cutuca.
 *  - O primeiro lembrete e o fluxo de pagamento (como o do Pix, nao depende do
 *    #admin). Do segundo em diante vale a chave "atendimento": desligada, o bot
 *    fala so o minimo.
 *  - Tudo passa pelo sender.js (fila anti-ban, "digitando...").
 *  - Idioma pelo DDI do telefone (idioma.js). Nao promete nada alem do pedido:
 *    o presente do lembrete de Pix da Nerix e decidido pelo painel de estoque
 *    por CODIGO DE PEDIDO da Nerix (Nintendo, uma vez por semana), que estas
 *    cobrancas nao tem; por isso nao se promete +1 jogo aqui.
 *  - Nunca cita o fornecedor.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const sender = require('./sender');
const telefones = require('./telefone');
const moeda = require('./moeda');
const jitter = require('./jitter');
const chaves = require('./chaves');
const store = require('./store');
const { idiomaDoTelefone } = require('./idioma');

const DATA_DIR = process.env.PONTE_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'xpag-pendentes.json');

const MIN = 60 * 1000;
const H = 60 * MIN;
const DIA = 24 * H;

/** Fuso de cada pais (hora civil do CLIENTE, nao a de Brasilia). */
const FUSO = { MX: 'America/Mexico_City', CO: 'America/Bogota', CL: 'America/Santiago', BR: 'America/Sao_Paulo' };
const PAIS_DA_MOEDA = { MXN: 'MX', COP: 'CO', CLP: 'CL' };
const JANELA = { ini: 9, fim: 21 };
const INTERVALO_MIN_MS = 2 * H;
const MAX_POR_VOLTA = 10;
const GUARDA_MS = 30 * DIA; // por quanto tempo o registro fica no disco

const ligado = () => process.env.XPAG_LEMBRETES !== 'false';

// ── Estado ───────────────────────────────────────────────────

/** @type {{pedidos: Record<string, any>}} */
let dados = { pedidos: {} };

function carregar() {
  try {
    dados = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!dados || typeof dados !== 'object' || !dados.pedidos) dados = { pedidos: {} };
  } catch {
    dados = { pedidos: {} };
  }
}

function persistir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(dados), 'utf8');
  } catch (err) {
    console.error('[xpag-lembretes] nao consegui gravar o estado:', err.message);
  }
}

function limparAntigos(agora = Date.now()) {
  let n = 0;
  for (const [id, c] of Object.entries(dados.pedidos)) {
    if ((c.visto || c.criadaEm || 0) < agora - GUARDA_MS) { delete dados.pedidos[id]; n++; }
  }
  return n;
}

// ── Entrada de dados (saneada: o corpo vem de fora) ──────────

const txt = (v, n = 120) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const soUrl = (v) => { const s = txt(v, 500); return /^https?:\/\/\S+$/i.test(s) ? s : ''; };

function primeiroNome(nome) {
  const p = txt(nome, 80).split(' ')[0] || '';
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : '';
}

/** Dados de pagamento que o cliente precisa para pagar. Sem documento algum. */
function pagamentoDe(p) {
  const x = p && typeof p === 'object' ? p : {};
  const out = {};
  const poe = (k, v) => { if (v) out[k] = v; };
  poe('clabe', txt(x.clabe, 30).replace(/\D/g, ''));
  poe('banco', txt(x.banco, 80));
  poe('beneficiario', txt(x.beneficiario, 80));
  poe('referenciaOxxo', txt(x.referenciaOxxo, 40));
  poe('urlVoucher', soUrl(x.urlVoucher));
  poe('qr', soUrl(x.qr));
  poe('copiaECola', txt(x.copiaECola, 600));
  poe('chaveBreb', txt(x.chaveBreb, 80));
  poe('checkoutUrl', soUrl(x.checkoutUrl));
  poe('linkPedido', soUrl(x.linkPedido));
  return out;
}

/**
 * Calendario de passos de uma cobranca. `at` e `ate` sao instantes absolutos:
 * o passo so sai entre os dois (e dentro da janela civil do cliente).
 *
 *   SPEI (24h)       30min, 6h, 4h antes de vencer
 *   CLABE aberta     30min, 6h, 24h
 *   OXXO (12 dias)   2h, 1 dia, 1 dia antes de vencer
 *   COP Nequi (45')  ~20min (antes de vencer) + oferta de novo codigo depois
 *   COP Bre-B (15')  ~7min  (antes de vencer) + oferta de novo codigo depois
 *   CLP (checkout)   30min, 4h, 20h (a XPag nao informa o vencimento)
 */
function passosDe(c) {
  const t0 = c.criadaEm;
  const exp = c.expiraEm;
  const p = (id, tipo, at, ate) => ({ id, tipo, at, ate, feito: null, pulado: null });

  if (c.pais === 'CO') {
    const fim = exp || t0 + (c.metodo === 'breb' ? 15 : 45) * MIN;
    const dur = fim - t0;
    return [
      p('r1', 'rapido', t0 + Math.round(dur * 0.45), t0 + Math.round(dur * 0.8)),
      p('vencida', 'vencida', fim + 10 * MIN, fim + 6 * H),
    ];
  }
  if (c.pais === 'CL') {
    return [
      p('r1', 'r1', t0 + 30 * MIN, t0 + 3 * H),
      p('r2', 'r2', t0 + 4 * H, t0 + 10 * H),
      p('r3', 'r3', t0 + 20 * H, exp ? Math.min(t0 + 26 * H, exp - 30 * MIN) : t0 + 26 * H),
    ];
  }
  if (c.metodo === 'oxxo') {
    const fim = exp || t0 + 12 * DIA;
    return [
      p('r1', 'r1', t0 + 2 * H, t0 + 10 * H),
      p('r2', 'r2', t0 + DIA, t0 + DIA + 12 * H),
      p('r3', 'r3', fim - DIA, fim - 3 * H),
    ];
  }
  if (c.metodo === 'spei' || c.metodo === 'clabe') {
    const fim = exp || (c.metodo === 'spei' ? t0 + DIA : null);
    return [
      p('r1', 'r1', t0 + 30 * MIN, t0 + 4 * H),
      p('r2', 'r2', t0 + 6 * H, t0 + 12 * H),
      fim ? p('r3', 'r3', fim - 4 * H, fim - 30 * MIN) : p('r3', 'r3', t0 + DIA, t0 + DIA + 6 * H),
    ];
  }
  return [];
}

/**
 * Trata o evento 'criada' do phaze-xpag. Devolve { ok, novo?, semTelefone?, motivo? }.
 * Repetido (mesmo pedido) nao reagenda nada.
 */
function registrarCriada(corpo, agora = Date.now()) {
  const b = corpo || {};
  const pedido = txt(b.pedido, 80);
  if (!pedido) return { ok: false, motivo: 'criada sem pedido' };
  if (dados.pedidos[pedido]) return { ok: true, novo: false };

  const moedaCod = txt(b.moeda, 6).toUpperCase();
  const pais = PAIS_DA_MOEDA[moedaCod];
  if (!pais) return { ok: false, motivo: `moeda "${moedaCod || '(vazia)'}" sem lembrete (so MXN, COP e CLP)` };
  const valor = Number(b.valor);
  if (!Number.isFinite(valor) || valor <= 0) return { ok: false, motivo: 'criada sem valor' };

  const cli = b.cliente && typeof b.cliente === 'object' ? b.cliente : {};
  const numero = cli.telefone ? telefones.paraWhatsApp(txt(cli.telefone, 30), pais) : null;
  const expMs = b.expiraEm ? new Date(b.expiraEm).getTime() : NaN;
  const criadaMs = (() => { const m = b.criadaEm ? new Date(b.criadaEm).getTime() : NaN; return Number.isFinite(m) && Math.abs(m - agora) < 3 * H ? m : agora; })();

  const c = {
    pedido,
    valor,
    moeda: moedaCod,
    pais,
    metodo: txt(b.metodo, 20).toLowerCase(),
    numero: numero || null,
    nome: primeiroNome(cli.nome),
    pagamento: pagamentoDe(b.pagamento),
    criadaEm: criadaMs,
    expiraEm: Number.isFinite(expMs) ? expMs : null,
    status: 'aberta',
    expirada: false,
    ultimoEnvio: null,
    visto: agora,
    passos: [],
  };
  c.passos = numero ? passosDe(c) : [];

  // Uma mensagem por pessoa: a cobranca nova e a que ela tentou por ultimo.
  if (numero) {
    for (const o of Object.values(dados.pedidos)) {
      if (o.status === 'aberta' && o.numero && telefones.mesmoNumero(o.numero, numero)) {
        o.status = 'substituida';
        o.fim = agora;
      }
    }
  }
  dados.pedidos[pedido] = c;
  limparAntigos(agora);
  persistir();
  console.log(`[xpag-lembretes] ${pedido} (${c.metodo || c.moeda}) ${numero ? `agendada para +${numero}` : 'SEM telefone: nenhum lembrete ao cliente'}`);
  return { ok: true, novo: true, semTelefone: !numero };
}

/**
 * Encerra o calendario. motivo 'paga' | 'cancelada' | 'expirada'.
 * 'expirada' so cancela os lembretes; a oferta de codigo novo (Colombia) segue.
 * Pago antes de a cobranca ser conhecida deixa uma marca, para uma 'criada'
 * atrasada nao lembrar quem ja pagou.
 */
function encerrar(pedido, motivo = 'paga', agora = Date.now()) {
  const id = txt(pedido, 80);
  if (!id) return false;
  const c = dados.pedidos[id];
  if (!c) {
    if (motivo === 'paga') {
      dados.pedidos[id] = { pedido: id, status: 'paga', fim: agora, visto: agora, passos: [], marca: true };
      persistir();
    }
    return false;
  }
  if (motivo === 'expirada') {
    if (c.status !== 'aberta' || c.expirada) return false;
    c.expirada = true;
    c.fim = agora;
    persistir();
    return true;
  }
  if (c.status === 'paga' || c.status === 'cancelada') return false;
  c.status = motivo === 'paga' ? 'paga' : 'cancelada';
  c.fim = agora;
  persistir();
  console.log(`[xpag-lembretes] ${id} encerrada (${motivo}): sem mais lembretes`);
  return true;
}

// ── Idioma, dinheiro e horario ───────────────────────────────

const NOME_MOEDA_ES = { MXN: 'pesos mexicanos', COP: 'pesos colombianos', CLP: 'pesos chilenos' };

function milhar(n, sep) {
  return String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** Valor como o cliente le: "$1,090 MXN", "$39.900 COP", "$6.090 CLP" (es) ou "MX$ 1.090,00" (pt). */
function dinheiro(valor, moedaCod, idioma) {
  if (idioma !== 'es') return moeda.formatar(valor, moedaCod);
  const m = String(moedaCod).toUpperCase();
  if (m === 'MXN') {
    const cent = Math.round((Math.abs(valor) - Math.trunc(Math.abs(valor))) * 100);
    return `$${milhar(valor, ',')}${cent ? `.${String(cent).padStart(2, '0')}` : ''} MXN`;
  }
  return `$${milhar(Math.round(valor), '.')} ${m}`;
}

function horaLocal(ms, pais) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: FUSO[pais] || FUSO.BR, hour: '2-digit', hour12: false }).format(new Date(ms))) % 24;
}

function diaLocal(ms, pais) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO[pais] || FUSO.BR }).format(new Date(ms));
}

const dentroDaJanela = (ms, pais) => { const h = horaLocal(ms, pais); return h >= JANELA.ini && h < JANELA.fim; };

/** "hoy" / "mañana" / null, conforme o dia local do cliente. */
function quandoVence(c, agora, idioma) {
  if (!c.expiraEm) return null;
  const dias = Math.round((Date.parse(diaLocal(c.expiraEm, c.pais)) - Date.parse(diaLocal(agora, c.pais))) / DIA);
  if (dias <= 0) return idioma === 'es' ? 'hoy' : 'hoje';
  if (dias === 1) return idioma === 'es' ? 'mañana' : 'amanhã';
  return idioma === 'es' ? 'pronto' : 'em breve';
}

// ── Textos ───────────────────────────────────────────────────
//
// Tres variantes por mensagem (a mesma frase para muita gente e padrao de
// spam), paragrafos curtos, 2 a 3 emojis no fim das linhas, nada de travessao.
// es = espanhol latino-americano neutro, tratando por "tu". pt = portugues.

const v = (n) => (n ? `, ${n}` : '');

const INTRO = {
  es: {
    r1: [
      (n) => `¡Hola${v(n)}! Vi que tu pedido quedó pendiente de pago 😊`,
      (n) => `¡Hola${v(n)}! ¿Pudiste hacer tu pago? Tu pedido sigue pendiente 😊`,
      (n) => `¡Hola${v(n)}! Todavía no veo reflejado el pago de tu pedido 🙂`,
    ],
    r2: [
      (n) => `¡Hola${v(n)}! Te recuerdo que tu pedido sigue esperando el pago 🙌`,
      (n) => `¡Hola${v(n)}! Por si se te pasó, tu pago sigue pendiente. Te dejo los datos otra vez 👇`,
      (n) => `¡Hola${v(n)}! Sigo viendo tu pedido sin pagar, así que te mando los datos de nuevo 😊`,
    ],
    r3: [
      (n, q) => `¡Hola${v(n)}! Último aviso: tu pago ${q ? `vence ${q}` : 'sigue pendiente'} ⏰`,
      (n, q) => `¡Hola${v(n)}! ${q ? `Tu pago vence ${q}` : 'Tu pago aún no se ha hecho'}, por si todavía lo quieres ⏰`,
      (n, q) => `¡Hola${v(n)}! Ya casi se acaba el plazo${q ? ` (vence ${q})` : ''} ⏰`,
    ],
    rapido: [
      (n) => `¡Hola${v(n)}! Tu código de pago vence en unos minutos ⏰`,
      (n) => `¡Hola${v(n)}! Aún alcanzas a pagar, el código vence muy pronto ⏰`,
      (n) => `¡Hola${v(n)}! Tu pago sigue pendiente y el código vence en breve ⏰`,
    ],
  },
  pt: {
    r1: [
      (n) => `Oi${v(n)}! Vi que seu pedido ficou aguardando pagamento 😊`,
      (n) => `Oi${v(n)}! Conseguiu fazer o pagamento? Seu pedido segue pendente 😊`,
      (n) => `Oi${v(n)}! Ainda não vi o pagamento do seu pedido 🙂`,
    ],
    r2: [
      (n) => `Oi${v(n)}! Só lembrando que seu pedido continua esperando o pagamento 🙌`,
      (n) => `Oi${v(n)}! Caso tenha passado batido, seu pagamento segue pendente. Deixo os dados de novo 👇`,
      (n) => `Oi${v(n)}! Seu pedido ainda está sem pagamento, então mando os dados outra vez 😊`,
    ],
    r3: [
      (n, q) => `Oi${v(n)}! Último aviso: seu pagamento ${q ? `vence ${q}` : 'segue pendente'} ⏰`,
      (n, q) => `Oi${v(n)}! ${q ? `Seu pagamento vence ${q}` : 'Seu pagamento ainda não foi feito'}, caso ainda queira ⏰`,
      (n, q) => `Oi${v(n)}! O prazo está acabando${q ? ` (vence ${q})` : ''} ⏰`,
    ],
    rapido: [
      (n) => `Oi${v(n)}! Seu código de pagamento vence em poucos minutos ⏰`,
      (n) => `Oi${v(n)}! Ainda dá tempo de pagar, o código vence logo ⏰`,
      (n) => `Oi${v(n)}! Seu pagamento segue pendente e o código vence em breve ⏰`,
    ],
  },
};

const FECHO = {
  es: [
    'Si ya pagaste o cambiaste de opinión, ignora este mensaje 👍',
    'Si ya hiciste el pago, no te preocupes y ignora este aviso 🙌',
    'Si ya pagaste o ya no lo necesitas, puedes ignorarlo 👍',
  ],
  pt: [
    'Se já pagou ou mudou de ideia, pode ignorar 👍',
    'Se você já fez o pagamento, fica tranquilo e ignora este aviso 🙌',
    'Se já pagou ou não precisa mais, pode ignorar 👍',
  ],
};

const VENCIDA = {
  es: [
    (n, loja) => [`¡Hola${v(n)}! Tu código de pago venció 😕`, '', `No pasa nada, puedes generar uno nuevo cuando quieras aquí: ${loja}`, '', 'Si tienes alguna duda, escríbeme por aquí 👍'],
    (n, loja) => [`¡Hola${v(n)}! El código de tu pedido ya venció 😕`, '', `Si todavía lo quieres, genera uno nuevo en ${loja} y listo`, '', 'Cualquier duda me escribes por aquí 🙌'],
    (n, loja) => [`¡Hola${v(n)}! Tu pago no alcanzó a completarse y el código venció 🙂`, '', `Puedes volver a intentarlo en ${loja}`, '', 'Si necesitas ayuda, estoy por aquí 👍'],
  ],
  pt: [
    (n, loja) => [`Oi${v(n)}! Seu código de pagamento venceu 😕`, '', `Sem problema, você pode gerar outro quando quiser aqui: ${loja}`, '', 'Qualquer dúvida, é só chamar por aqui 👍'],
    (n, loja) => [`Oi${v(n)}! O código do seu pedido já venceu 😕`, '', `Se ainda quiser, gere outro em ${loja} e pronto`, '', 'Qualquer dúvida me chama por aqui 🙌'],
    (n, loja) => [`Oi${v(n)}! Seu pagamento não chegou a ser concluído e o código venceu 🙂`, '', `Dá para tentar de novo em ${loja}`, '', 'Se precisar de ajuda, estou por aqui 👍'],
  ],
};

/** Bloco com o que o cliente precisa para pagar, por metodo. */
function blocoDePagamento(c, idioma) {
  const es = idioma === 'es';
  const p = c.pagamento || {};
  const din = dinheiro(c.valor, c.moeda, idioma);
  const nomeM = es ? NOME_MOEDA_ES[c.moeda] : null;
  const total = es ? `Monto: *${din}*${nomeM ? ` (${nomeM})` : ''}` : `Valor: *${din}*`;
  const exato = es ? `Monto exacto: *${din}*${nomeM ? ` (${nomeM})` : ''}` : `Valor exato: *${din}*`;
  const L = [];

  if (c.pais === 'MX' && (c.metodo === 'spei' || c.metodo === 'clabe')) {
    L.push(es ? 'Paga con transferencia SPEI desde la app de tu banco:' : 'Pague por transferência SPEI no app do seu banco:');
    L.push(c.metodo === 'spei' ? exato : total);
    if (p.clabe) L.push(`CLABE: \`${p.clabe}\``);
    if (p.banco) L.push(`${es ? 'Banco' : 'Banco'}: ${p.banco}`);
    if (p.beneficiario) L.push(`${es ? 'Beneficiario' : 'Favorecido'}: ${p.beneficiario}`);
  } else if (c.pais === 'MX' && c.metodo === 'oxxo') {
    L.push(es ? 'Paga en cualquier tienda OXXO con esta referencia:' : 'Pague em qualquer loja OXXO com esta referência:');
    L.push(total);
    if (p.referenciaOxxo) L.push(`${es ? 'Referencia' : 'Referência'}: \`${p.referenciaOxxo}\``);
    if (p.urlVoucher) L.push(`${es ? 'Ficha de pago' : 'Ficha de pagamento'}: ${p.urlVoucher}`);
  } else if (c.pais === 'CO') {
    if (c.metodo === 'breb') {
      L.push(es ? 'Paga con Bre-B usando esta llave:' : 'Pague com Bre-B usando esta chave:');
      if (p.chaveBreb) L.push(`\`${p.chaveBreb}\``);
    } else {
      L.push(es ? 'Paga con Nequi escaneando el QR o abriendo este enlace:' : 'Pague com Nequi escaneando o QR ou abrindo este link:');
    }
    L.push(total);
    const link = p.checkoutUrl || p.qr;
    if (link) L.push(link);
    else if (p.copiaECola) L.push(`${es ? 'Código' : 'Código'}: \`${p.copiaECola}\``);
  } else if (c.pais === 'CL') {
    L.push(es ? 'Paga de forma segura en este enlace:' : 'Pague de forma segura neste link:');
    L.push(total);
    if (p.checkoutUrl) L.push(p.checkoutUrl);
  } else {
    L.push(total);
  }
  if (p.linkPedido) L.push('', `${es ? 'Aquí ves el estado de tu pedido' : 'Aqui você acompanha seu pedido'}: ${p.linkPedido}`);
  return L;
}

/** Ultima variante usada por tipo, para nao repetir seguida (memoria do processo). */
const ultimaVariante = {};

function escolher(tipo, lista, escolha) {
  if (Number.isInteger(escolha)) return { texto: lista[escolha % lista.length], indice: escolha % lista.length };
  const r = jitter.variar(lista, ultimaVariante[tipo]);
  ultimaVariante[tipo] = r.indice;
  return r;
}

/**
 * Texto de um passo. `variante` (0..2) fixa a variante, so para teste.
 * `agora` define o "vence hoje/amanha".
 */
function montarTexto(c, passo, idioma, { agora = Date.now(), variante } = {}) {
  const n = c.nome;
  const lingua = idioma === 'es' ? 'es' : 'pt';
  if (passo.tipo === 'vencida') {
    const loja = config.store.url;
    return escolher('vencida', VENCIDA[lingua], variante).texto(n, loja).join('\n');
  }
  const tipo = passo.tipo;
  const intro = escolher(`${tipo}:${lingua}`, INTRO[lingua][tipo], variante).texto(n, quandoVence(c, agora, lingua));
  const fecho = escolher(`fecho:${lingua}`, FECHO[lingua], variante).texto;
  return [intro, '', ...blocoDePagamento(c, lingua), '', fecho].join('\n');
}

// ── Varredura ────────────────────────────────────────────────

/** Consulta a XPag antes de cutucar: quem ja pagou nao pode receber cobranca. */
async function jaPagoNaXpag(c) {
  try {
    const xpag = require('./xpag');
    if (!xpag.configurado()) return false;
    const { statusPago } = require('./xpagVendas');
    const r = await xpag.consultar({ externalId: c.pedido });
    if (!r || !r.ok) return false;
    return statusPago(r.status, r.moeda || c.moeda) || (Array.isArray(r.pagamentos) && r.pagamentos.some((x) => statusPago(x.status, r.moeda || c.moeda)));
  } catch {
    return false;
  }
}

let rodando = false;

/** Uma volta. Devolve quantos lembretes enfileirou. */
async function tick(agora = Date.now()) {
  if (rodando || !ligado()) return 0;
  rodando = true;
  let enviados = 0;
  try {
    let sujo = false;
    for (const c of Object.values(dados.pedidos)) {
      if (enviados >= MAX_POR_VOLTA) break;
      if (c.status !== 'aberta' || !c.numero || !c.passos?.length) continue;

      // Vencida pelo relogio (o aviso 'expirada' pode nem ter chegado).
      const venceu = c.expirada || (c.expiraEm && agora >= c.expiraEm);

      // Passos que ja perderam o prazo, ou que so valiam antes de vencer.
      for (const s of c.passos) {
        if (s.feito || s.pulado) continue;
        if (agora > s.ate) { s.pulado = 'prazo'; sujo = true; }
        else if (venceu && s.tipo !== 'vencida') { s.pulado = 'vencida'; sujo = true; }
      }
      const vencidos = c.passos.filter((s) => !s.feito && !s.pulado && agora >= s.at);
      if (!vencidos.length) continue;

      // Fora da hora civil do cliente, ou conversa com atendente: espera.
      if (!dentroDaJanela(agora, c.pais)) continue;
      const contato = store.getContact(c.numero);
      if (contato && contato.paused) continue;
      const rapido = c.pais === 'CO';
      if (c.ultimoEnvio && !rapido && agora - c.ultimoEnvio < INTERVALO_MIN_MS) continue;

      // Vários vencidos de uma vez (ficaram esperando a janela): sai só o último.
      const passo = vencidos[vencidos.length - 1];
      for (const s of vencidos) if (s !== passo) { s.pulado = 'superado'; sujo = true; }

      // Do segundo em diante vale a chave "atendimento".
      const primeiro = c.passos.find((s) => s.tipo !== 'vencida');
      if (passo !== primeiro && !chaves.ligada('atendimento')) { passo.pulado = 'atendimento_desligado'; sujo = true; continue; }

      if (await jaPagoNaXpag(c)) { encerrar(c.pedido, 'paga', agora); continue; }
      if (c.status !== 'aberta') continue; // pago/cancelado enquanto consultava

      // Marca ANTES de enviar.
      passo.feito = agora;
      c.ultimoEnvio = agora;
      c.visto = agora;
      persistir();
      sujo = false;
      const idioma = idiomaDoTelefone(c.numero);
      const texto = montarTexto(c, passo, idioma, { agora });
      enviados++;
      sender
        .send(c.numero, texto)
        .then(() => console.log(`[xpag-lembretes] ${passo.id} (${idioma}) enviado para ${c.numero} (${c.pedido})`))
        .catch((err) => console.error(`[xpag-lembretes] falha ao lembrar ${c.pedido}:`, err.message));
    }
    if (sujo) persistir();
  } finally {
    rodando = false;
  }
  return enviados;
}

/** Cobrancas em aberto (nao pagas, nao substituidas, nao vencidas) para o resumo do dia. */
function pendentes(agora = Date.now()) {
  let total = 0;
  let semTelefone = 0;
  for (const c of Object.values(dados.pedidos)) {
    if (c.status !== 'aberta' || c.marca || c.expirada) continue;
    if (c.expiraEm && agora >= c.expiraEm) continue;
    if (!c.expiraEm && agora - c.criadaEm > 2 * DIA) continue;
    total++;
    if (!c.numero) semTelefone++;
  }
  return { total, semTelefone };
}

let timer = null;

function iniciar({ intervaloMs = 60 * 1000 } = {}) {
  if (timer) return;
  if (!ligado()) { console.log('[xpag-lembretes] desligados (XPAG_LEMBRETES=false)'); return; }
  timer = setInterval(() => tick().catch((err) => console.error('[xpag-lembretes] varredura:', err.message)), intervaloMs);
  timer.unref();
  console.log('[xpag-lembretes] lembretes de pagamento da XPag ligados (varredura de 1 em 1 min, 9h-21h no fuso do cliente)');
}

function parar() {
  if (timer) clearInterval(timer);
  timer = null;
}

carregar();

module.exports = {
  registrarCriada,
  encerrar,
  tick,
  iniciar,
  parar,
  pendentes,
  montarTexto,
  passosDe,
  dinheiro,
  _dados: () => dados,
  _recarregar: carregar,
  _limpar: () => { dados = { pedidos: {} }; persistir(); },
};
