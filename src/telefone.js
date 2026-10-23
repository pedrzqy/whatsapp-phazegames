'use strict';

/**
 * Telefones: do campo do checkout ao número que o WhatsApp entende.
 *
 * A loja vende no Brasil (+55) e no México (+52), e este arquivo existe porque
 * o código inteiro assumia só o primeiro. O telefone de um mexicano caía na
 * regra "10 dígitos = BR, prefixa 55" (e o 5255... virava o número de um
 * estranho no Rio Grande do Sul) ou, com 52 na frente, não passava no filtro e
 * virava "entrega manual". Pix, confirmação de pagamento, chave e #meulogin
 * ficavam sem destino.
 *
 * Forma CANÔNICA, a que `paraWhatsApp` devolve e que se compara:
 *   BR → 55 + DDD + número (12 ou 13 dígitos), como sempre foi.
 *   MX → 52 + 10 dígitos. O "1" que o México já teve entre o 52 e o número
 *        (521...) NÃO faz parte da forma canônica: o WhatsApp atual usa 52 +
 *        10, mas contas e payloads antigos ainda trazem 521 + 10.
 *   resto → só dígitos, quando veio com + ou 00 na frente.
 *
 * Quem fala com o WhatsApp de verdade (evolution.js) resolve o JID real do
 * número estrangeiro com o onWhatsApp da Evolution; aqui só se normaliza.
 */

// DDDs que existem no Brasil. Serve para uma coisa só: um número de 10 dígitos
// sem país cujo início NÃO é DDD brasileiro não pode ser BR, então é do México.
const DDDS_BR = new Set(
  ('11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 ' +
    '51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 ' +
    '91 92 93 94 95 96 97 98 99').split(' '),
);

/**
 * País a partir do que o checkout/payload trouxer: 'MX', 'BR', 'CO', 'CL' ou null.
 * Aceita sigla, nome, código de discagem e moeda (MXN → MX, BRL → BR).
 */
function paisDe(valor) {
  const s = String(valor ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toLowerCase();
  if (!s) return null;
  if (['mx', 'mex', 'mexico', 'mxn', '52', '+52', '0052'].includes(s)) return 'MX';
  if (['br', 'bra', 'brasil', 'brazil', 'brl', '55', '+55', '0055'].includes(s)) return 'BR';
  if (['co', 'col', 'colombia', 'cop', '57', '+57', '0057'].includes(s)) return 'CO';
  if (['cl', 'chl', 'chile', 'clp', '56', '+56', '0056'].includes(s)) return 'CL';
  return null;
}

/**
 * Telefone (como veio) → número de WhatsApp canônico, ou null.
 *
 * Continua ESTRITO: adivinhar errado é mandar a chave de um cliente para o
 * telefone de outro. `pais` (opcional) é a pista do pedido; sem ele, 10 dígitos
 * seguem sendo Brasil, exceto se o começo não for DDD brasileiro.
 */
function paraWhatsApp(telefone, pais) {
  const bruto = String(telefone ?? '').trim();
  let so = bruto.replace(/\D/g, '');
  if (!so) return null;

  // + ou 00 na frente: o país está escrito, e escrito vence qualquer palpite.
  let explicito = /^\s*\+/.test(bruto);
  if (!explicito && so.startsWith('00') && !/^\s*\(/.test(bruto)) {
    explicito = true;
  }
  if (so.startsWith('00')) so = so.replace(/^0+/, '');
  if (!so) return null;

  if (explicito) {
    if (so.startsWith('55')) return /^55\d{10,11}$/.test(so) ? so : null;
    if (so.startsWith('52')) return mx(so.slice(2));
    return so.length >= 8 && so.length <= 15 ? so : null;
  }

  const p = paisDe(pais);

  if (so.length === 13 && so.startsWith('521')) return `52${so.slice(3)}`;
  if (so.length === 12 && so.startsWith('52')) return so;
  if (so.length === 12 && so.startsWith('55')) return so;
  if (so.length === 13 && so.startsWith('55')) return so;

  // Colômbia (57 + 10 dígitos, celular começa com 3) e Chile (56 + 9 dígitos,
  // celular começa com 9). Só com a pista do pedido: sem ela 10 dígitos
  // continuam sendo Brasil/México como sempre.
  if (p === 'CO') {
    if (so.length === 12 && so.startsWith('57')) return so;
    return /^3\d{9}$/.test(so) ? `57${so}` : null;
  }
  if (p === 'CL') {
    if (so.length === 11 && so.startsWith('56')) return so;
    return /^9\d{8}$/.test(so) ? `56${so}` : null;
  }

  if (so.length === 11) {
    // México sem o 52: 1 + 10 dígitos (o antigo "móvil").
    if (p === 'MX') return so.startsWith('1') ? `52${so.slice(1)}` : null;
    return `55${so}`;
  }
  if (so.length === 10) {
    if (p === 'MX') return `52${so}`;
    if (p === 'BR') return `55${so}`;
    return DDDS_BR.has(so.slice(0, 2)) ? `55${so}` : `52${so}`;
  }
  return null;
}

/** Resto do número mexicano (depois do 52) → 52 + 10 dígitos. */
function mx(resto) {
  if (/^\d{10}$/.test(resto)) return `52${resto}`;
  if (/^1\d{10}$/.test(resto)) return `52${resto.slice(1)}`;
  return null;
}

/**
 * Todas as formas em que o MESMO telefone aparece no WhatsApp. Para comparar
 * (operador, pedido ↔ conversa) e para tentar o JID.
 *   MX: 52 + 10  e  521 + 10.
 *   BR: com e sem o nono dígito.
 */
function formasDoNumero(numero) {
  const n = String(numero ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!n) return [];
  if (n.startsWith('52') && (n.length === 12 || n.length === 13)) {
    const dez = n.length === 13 ? (n[2] === '1' ? n.slice(3) : null) : n.slice(2);
    return dez ? [`52${dez}`, `521${dez}`] : [n];
  }
  if (n.startsWith('55')) {
    const ddd = n.slice(2, 4);
    const resto = n.slice(4);
    if (resto.length === 9 && resto.startsWith('9')) return [n, `55${ddd}${resto.slice(1)}`];
    if (resto.length === 8) return [n, `55${ddd}9${resto}`];
  }
  return [n];
}

/** Os dois números são o mesmo telefone (mesmo com 521/52 ou nono dígito)? */
function mesmoNumero(a, b) {
  const fa = formasDoNumero(a);
  const fb = formasDoNumero(b);
  return fa.length > 0 && fa.some((x) => fb.includes(x));
}

/** Lê o país do pedido cru da Nerix, onde quer que ele venha. */
function paisDoPedido(cru) {
  if (!cru || typeof cru !== 'object') return null;
  const c = cru.customer || {};
  const candidatos = [
    cru.customer_country, cru.country, cru.country_code, cru.customer_country_code,
    cru.customer_phone_country, cru.phone_country, cru.phone_country_code,
    c.country, c.country_code, c.phone_country, c.phone_country_code, c.phone_code,
    cru.billing_address?.country, cru.billing?.country,
    cru.currency, cru.currency_code,
  ];
  for (const v of candidatos) {
    const p = paisDe(v);
    if (p) return p;
  }
  return null;
}

module.exports = { paraWhatsApp, formasDoNumero, mesmoNumero, paisDe, paisDoPedido, DDDS_BR };
