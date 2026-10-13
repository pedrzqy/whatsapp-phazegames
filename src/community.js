'use strict';

/**
 * AGENTE DE COMUNIDADE — posta conteúdo no grupo do WhatsApp.
 *
 * FASE 1 (só SAÍDA, risco baixo): agendador posta, em horários de pico (BRT),
 * um conteúdo rotativo gerado a partir de dados REAIS da Nerix:
 *   - 🏆 Top mais vendidos (products.sales_count)
 *   - 💰 Promoções da loja (promotional_price em produtos/variantes)
 *   - 🎟️ Cupom ativo (coupons públicos, is_active && !is_secret)
 *
 * Segurança: default DESLIGADO + dry-run (loga em vez de enviar). Todo envio passa
 * pela fila anti-ban do sender.js. Não lê mensagens do grupo (isso é Fase 2).
 * Instância/grupo são configuráveis (env) → migrar p/ número dedicado = trocar config.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const nerix = require('./nerix');
const news = require('./news');
const sender = require('./sender');
const evolution = require('./evolution');
const ai = require('./ai');
const saudacoes = require('./saudacoes');
const jitter = require('./jitter');

const cfg = config.community;
const STORE_URL = config.store.url;

let timer = null;
let running = false;

// ─── Estado persistido (quais slots já postaram + rotação de conteúdo) ───
//
// PONTE_DATA_DIR pelo mesmo motivo do store.js, do estado.js e do vendas.js:
// este arquivo era o ultimo dos quatro que nao honrava a variavel, e o efeito e
// silencioso. Um teste que encoste no agendador grava no community.json de
// PRODUCAO -- e ali mora quais anuncios ja sairam hoje e se o grupo esta aberto.
// Rodar a suite no servidor podia reabrir o grupo de madrugada.
const DATA_DIR = process.env.PONTE_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'community.json');
let state = { posts: {}, rotation: 0 };
try {
  if (fs.existsSync(FILE)) state = { posts: {}, rotation: 0, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch (err) { console.error('[community] falha ao carregar estado:', err.message); }

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state), 'utf8');
  } catch (err) { console.error('[community] falha ao salvar estado:', err.message); }
}

// ─── Variação de texto ───────────────────────────────────────────────
//
// Todo trecho fixo de post sai de uma lista e nunca repete o último usado
// (índice gravado em state.textoUlt, que sobrevive a reinício). Texto idêntico
// todo dia, no mesmo minuto, é o que o WhatsApp lê como robô.
const TEXTOS = {
  bestHead: ['Os *mais vendidos* da Phaze Games agora 🏆', 'O que tá bombando na Phaze Games 🔥', 'Ranking dos queridinhos da galera 🏆', 'Os jogos mais pedidos da Phaze Games ⭐'],
  bestFoot: ['Garanta o seu em {url} 🎮🔥', 'Tá tudo em {url} 🛒✨', 'Dá uma olhada em {url} 👀🎮', 'Confere lá: {url} 🕹️💚'],
  promoIntro: ['Destaque do dia na *Phaze Games*, pra Nintendo Switch 🎮', 'Bora jogar? Olha esse pra Nintendo Switch 🔥', 'Que tal esse hoje, pra Nintendo Switch? 🕹️', 'Olha esse aqui na *Phaze Games*, pra Nintendo Switch ⭐', 'Sugestão da *Phaze Games* pra Nintendo Switch 🍄'],
  promoDePor: ['De ~{de}~ por *{por}* 💰', 'Antes ~{de}~, agora *{por}* 💸', 'Saindo de ~{de}~ por *{por}* 🤑'],
  promoPreco: ['Por *{por}* 💰', 'Só *{por}* 💵', 'Preço: *{por}* 🤑'],
  promoGarantia: [
    'Jogo 100% original, com garantia vitalícia e entrega em até 30 minutos ✅',
    'Original, com garantia vitalícia. Chega em até 30 minutos ⚡',
    'Entrega em até 30 minutos, jogo original e garantia vitalícia 🔒',
    'Você recebe em até 30 minutos, e o jogo é original com garantia vitalícia ✅',
  ],
  promoCta: ['Garanta o seu: {url} 🛒', 'Pega o seu aqui: {url} 👈', 'Tá disponível aqui: {url} 🎁', 'Confere e garante o seu: {url} 🚀'],
  cupomHead: ['Cupom ativo agora 🎟️', 'Solta o cupom! 🎁', 'Bora economizar? 💸', 'Tem cupom rolando 🔥'],
  cupomCorpo: ['{off} na sua compra em {url} 🛒', 'Ganhe {off} na sua compra em {url} 🎮', '{off} pra usar em {url} 💚'],
  cupomFim: ['É só aplicar o código *{code}* no checkout 😉', 'Aplica o código *{code}* no checkout e pronto ✅', 'Digita *{code}* no checkout pra usar 🙌'],
  newsHead: ['Saiu novidade no mundo {fonte}! 📰', 'Fresquinho do mundo {fonte}! 🔥', 'Rolou no mundo {fonte}! 🎮', 'Notícia nova do mundo {fonte}! 🗞️'],
  newsGancho: ['O que você achou? 👀', 'Já tinha visto essa? 🤔', 'Bora comentar aqui! 💬'],
  newsLink: ['Leia mais: {link} 👇', 'Veja na íntegra: {link} 🔗', 'Matéria completa: {link} 📖'],
  reviewHead: ['Saiu *avaliação* nova de {fonte}! ⭐', 'Review fresquinha de {fonte}! 📝', 'Saiu análise de {fonte}! 🔥', '*Análise* nova de {fonte}! 🎮'],
  reviewLoja: ['Tá na *Phaze Games*: {link} 🛒', 'Você acha na *Phaze Games*: {link} 🎮', 'Disponível na *Phaze Games*: {link} ✅'],
  reviewLink: ['Review completa: {link} 📖', 'Leia a review completa: {link} 👀', 'Análise completa aqui: {link} 👇'],
  avalPedido: [
    'Quem já comprou aqui, conta pra gente como foi? 👀',
    'Fala, pessoal! Quem já pegou jogo com a gente, deixa o feedback aí 👇',
    'Comprou com a gente e deu tudo certo? Conta aqui pro pessoal 😄',
    'A opinião de vocês ajuda demais quem tá chegando agora 🙌',
    'Já jogou algo que pegou com a gente? Conta como foi a experiência 🎮',
    'Seu feedback faz diferença pra quem ainda tá em dúvida 💬',
  ],
  avalLink: ['Deixa sua avaliação aqui: {url} ⭐', 'Sua avaliação vai aqui: {url} 💚', 'Avalia a gente por aqui: {url} 🙏'],
  avalGrupo: [
    'É só responder aqui no grupo, leva 10 segundos e ajuda muita gente 💚',
    'Basta responder aqui no grupo, leva só 10 segundos e ajuda muita gente ⭐',
    'Responde aqui mesmo no grupo: são 10 segundos e ajuda quem tá chegando 🙏',
  ],
  avalFim: ['Ainda não comprou? {url} 🛒', 'Ainda não conhece a loja? {url} 👀', 'Quer conhecer a loja? {url} 🎮'],
  noiteRodape: [
    '_O grupo volta a abrir por volta das {h}h._',
    '_Amanhã, por volta das {h}h, o grupo volta a abrir._',
    '_Nos vemos de manhã: o grupo volta a abrir perto das {h}h._',
  ],
};

/** Sorteia uma variação de TEXTOS[chave] diferente da última, e preenche {campos}. */
function varia(chave, campos = {}) {
  state.textoUlt = state.textoUlt || {};
  const { texto, indice } = jitter.variar(TEXTOS[chave], state.textoUlt[chave]);
  state.textoUlt[chave] = indice;
  saveState();
  return texto.replace(/\{(\w+)\}/g, (_, k) => (campos[k] != null ? campos[k] : ''));
}

// ─── Helpers ─────────────────────────────────────────────────────────
const brl =(n) => 'R$ ' + Number(n).toFixed(2).replace('.', ',');

/** Hora atual no fuso de Brasília (UTC-3). */
function brt(now) {
  const d = new Date(now - 3 * 60 * 60 * 1000);
  return {
    hour: d.getUTCHours(),
    // O minuto só passou a importar quando o "bom dia" precisou sair ANTES de
    // o grupo abrir. O resto da agenda é por hora cheia.
    minute: d.getUTCMinutes(),
    dateKey: d.toISOString().slice(0, 10),
  };
}

/** Menor preço válido do produto (considera variantes). */
function lowestPrice(p) {
  const cands = [Number(p.price), ...(p.variants || []).map((v) => Number(v.price))].filter((n) => n > 0);
  return cands.length ? Math.min(...cands) : 0;
}

/** Encurta nomes tipo "Zelda - Mídia Digital - Nintendo Switch" → "Zelda". */
function cleanName(name) {
  return String(name || '')
    .replace(/\s*-\s*m[ií]dia digital.*$/i, '')
    .replace(/\s*-\s*ni?ntendo switch.*$/i, '')
    .trim() || String(name || '').trim();
}

function productLink(slug) {
  return slug && STORE_URL ? `${STORE_URL}/package/${slug}` : STORE_URL;
}

/** URL completa da imagem de um produto da Nerix (caminho relativo → CDN). */
function storeImage(images) {
  const p = Array.isArray(images) ? images[0] : null;
  if (!p) return null;
  return /^https?:\/\//i.test(p) ? p : `https://cdn.nerix.com.br/${String(p).replace(/^\/+/, '')}`;
}

/** Procura o jogo na loja Nerix pelo nome. Retorna { image, link } se achar. */
async function storeMatch(gameName) {
  const nome = (gameName || '').trim();
  if (!nome) return null;
  try {
    const data = await nerix.listProducts({ search: nome, limit: 3 });
    const list = data.data || data || [];
    const hit = list[0];
    if (!hit) return null;
    return { image: storeImage(hit.images), link: productLink(hit.slug) };
  } catch { return null; }
}

// ─── Geradores de conteúdo (retornam texto ou null se não há conteúdo) ──
async function genBestSellers() {
  const prods = await nerix.listProducts();
  const list = Array.isArray(prods) ? prods : (prods.data || []);
  const top = list
    .filter((p) => Number(p.sales_count) > 0)
    .sort((a, b) => Number(b.sales_count) - Number(a.sales_count))
    .slice(0, 5);
  if (!top.length) return null;

  const linhas = top.map((p, i) => `${i + 1}. ${cleanName(p.name)} — ${brl(lowestPrice(p))}`);
  return (
    `${varia('bestHead')}\n\n` +
    linhas.join('\n') +
    `\n\n${varia('bestFoot', { url: STORE_URL })}`
  );
}

/** Menor preço de venda de um produto + o "de" (se tiver desconto). */
function bestPrice(p) {
  const cands = [{ price: p.price, promo: p.promotional_price }, ...(p.variants || []).map((v) => ({ price: v.price, promo: v.promotional_price }))];
  let por = Infinity;
  let de = null;
  for (const c of cands) {
    const nums = [Number(c.price), Number(c.promo)].filter((n) => n > 0);
    if (!nums.length) continue;
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    if (lo < por) { por = lo; de = hi > lo ? hi : null; }
  }
  return por === Infinity ? null : { por, de };
}

/** PROMOÇÃO: sorteia um jogo de NINTENDO da loja (com imagem + preço) e faz um card p/ vender. */
async function genPromo() {
  const data = await nerix.listProducts();
  const list = Array.isArray(data) ? data : (data.data || []);
  const recent = new Set(state.promoRecent || []);
  const nintendo = list.filter((p) =>
    /nintendo|switch/i.test(p.name || '') &&
    bestPrice(p) &&
    Array.isArray(p.images) && p.images[0] &&
    p.slug && !recent.has(p.slug)
  );
  // Embaralha (Fisher-Yates) → jogo aleatório.
  for (let i = nintendo.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nintendo[i], nintendo[j]] = [nintendo[j], nintendo[i]];
  }
  for (const p of nintendo.slice(0, 15)) {
    const image = storeImage(p.images);
    if (!(await news.imageOk(image))) continue; // só posta com imagem que funciona
    // Marca como promovido recentemente (cap 25) p/ não repetir seguido.
    state.promoRecent = [...(state.promoRecent || []).filter((s) => s !== p.slug), p.slug].slice(-25);
    saveState();

    const pr = bestPrice(p);
    const precoLinha = pr.de
      ? varia('promoDePor', { de: brl(pr.de), por: brl(pr.por) })
      : varia('promoPreco', { por: brl(pr.por) });
    const text =
      `${varia('promoIntro')}\n\n` +
      `*${cleanName(p.name)}*\n` +
      `${precoLinha}\n` +
      `${varia('promoGarantia')}\n\n` +
      `${varia('promoCta', { url: productLink(p.slug) })}`;
    return { text, image };
  }
  return null;
}

async function genCoupon() {
  const coupons = await nerix.listCoupons();
  const list = (Array.isArray(coupons) ? coupons : (coupons.data || []))
    .filter((c) => c.is_active && !c.is_secret && c.code)
    .filter((c) => !c.valid_until || new Date(c.valid_until).getTime() > Date.now());
  if (!list.length) return null;
  // Preferir o de maior valor percentual.
  list.sort((a, b) => Number(b.value) - Number(a.value));
  const c = list[0];
  const off = c.type === 'percentage' ? `${Number(c.value).toFixed(0).replace(/\.0$/, '')}% OFF` : `${brl(c.value)} OFF`;
  return (
    `${varia('cupomHead')}\n\n` +
    `Código: *${c.code}*\n` +
    `${varia('cupomCorpo', { off, url: STORE_URL })}\n` +
    `${varia('cupomFim', { code: c.code })}`
  );
}

async function genNews() {
  const latest = await news.fetchLatestNews();
  const seen = state.newsSeen || {};
  const fresh = latest.filter((n) => !seen[n.link]).sort(nintendoFirst).slice(0, 10);
  for (const n of fresh) {
    if (!(await news.imageOk(n.image))) continue; // SÓ posta com imagem que funciona
    markSeen(n.link);
    const tituloPt = await ai.translate(n.title);
    const text =
      `${varia('newsHead', { fonte: n.source })}\n\n` +
      `${tituloPt}\n${varia('newsGancho')}\n\n` +
      varia('newsLink', { link: n.link });
    return { text, image: n.image };
  }
  return null; // nada com imagem agora
}

// Ordena colocando Nintendo PRIMEIRO (o grupo é ~97% nintendista), depois por data desc.
function nintendoFirst(a, b) {
  const na = a.source === 'Nintendo' ? 1 : 0;
  const nb = b.source === 'Nintendo' ? 1 : 0;
  return (nb - na) || ((b.ts || 0) - (a.ts || 0));
}

/** Marca um link como visto no estado (compartilhado por news/reviews), com cap de 80. */
function markSeen(link) {
  const seen = state.newsSeen || {};
  seen[link] = Date.now();
  const keys = Object.keys(seen);
  if (keys.length > 80) for (const k of keys.slice(0, keys.length - 80)) delete seen[k];
  state.newsSeen = seen;
  saveState();
}

async function genReviews() {
  const items = await news.fetchLatestReviews();
  const seen = state.newsSeen || {};
  const fresh = items.filter((r) => !seen[r.link]).sort(nintendoFirst).slice(0, 8);
  for (const r of fresh) {
    // Título: "Review: Jogo (Plataforma) - Veredito".
    const m = r.title.match(/^Review:\s*(.+?)\s*\(([^)]+)\)\s*[-–—]\s*(.+)$/i);
    const jogo = (m ? m[1] : r.title.replace(/^Review:\s*/i, '')).trim();
    const plataforma = m ? m[2].trim() : '';
    const veredito = m ? m[3].trim() : '';

    // Imagem: prefere a da LOJA (Nerix, acessível + vira link de compra);
    // a imagem do site é bloqueada por Cloudflare. SÓ posta se a imagem funcionar.
    const loja = await storeMatch(jogo);
    const image = (loja && loja.image) || r.image || null;
    if (!(await news.imageOk(image))) continue; // sem imagem boa → próximo candidato
    markSeen(r.link);

    const veredictoPt = veredito ? await ai.translate(veredito) : '';
    const compra = loja ? `\n${varia('reviewLoja', { link: loja.link })}` : '';
    const text =
      `${varia('reviewHead', { fonte: r.source })}\n\n` +
      `*${jogo}*${plataforma ? ` — ${plataforma}` : ''} ${['🎮', '🕹️', '👾'][Math.floor(Math.random() * 3)]}\n` +
      (veredictoPt ? `\n_${veredictoPt}_\n` : '') +
      compra +
      `\n\n${varia('reviewLink', { link: r.link })}`;
    return { text, image };
  }
  return null; // nada com imagem agora
}

/**
 * AVALIAÇÃO: convida quem já comprou a contar a experiência.
 *
 * Reputação é o que faz um desconhecido comprar jogo digital de uma loja
 * pequena, e ela não aparece sozinha — cliente satisfeito some, cliente
 * insatisfeito escreve. Pedir é o que equilibra.
 *
 * NADA de dado de compra aqui. O post é o mesmo para todo mundo e não cita
 * nome, telefone, pedido nem produto comprado: isso é grupo, e o que sai aqui
 * é público para todos os membros. Prova social se faz com quem responde
 * porque quis, não expondo quem comprou.
 *
 * Com imagem porque post com card para de rolar o polegar; sem imagem que
 * funcione, não posta — mesma regra dos outros geradores, e pelo mesmo motivo
 * (imagem quebrada no grupo parece loja abandonada).
 */
// Os pedidos de avaliação moram em TEXTOS.avalPedido (seis variações).

async function genAvaliacao() {
  let image = cfg.avaliacaoImagem || null;

  if (!image) {
    // Capa de um jogo da loja: imagem que já sabemos que carrega, e que fala
    // do assunto do grupo. Sorteia entre os primeiros para o post não sair
    // sempre com a mesma capa.
    try {
      const data = await nerix.listProducts({ limit: 20 });
      const list = (data.data || data || []).filter((p) => Array.isArray(p.images) && p.images[0]);
      for (const p of list.sort(() => Math.random() - 0.5).slice(0, 5)) {
        const url = storeImage(p.images);
        if (await news.imageOk(url)) { image = url; break; }
      }
    } catch (err) {
      console.warn('[community] avaliação: não achei capa:', err.response?.status || err.message);
    }
  }

  if (!image) return null; // sem imagem boa, não posta

  const linhas = [varia('avalPedido'), ''];
  if (cfg.avaliacaoUrl) {
    linhas.push(varia('avalLink', { url: cfg.avaliacaoUrl }));
  } else {
    linhas.push(varia('avalGrupo'));
  }
  linhas.push('', varia('avalFim', { url: STORE_URL }));

  return { text: linhas.join('\n'), image };
}

// Geradores por chave (usados pela AGENDA de cadência em config.community.schedule).
const GENERATORS = {
  news: genNews,
  reviews: genReviews,
  promo: genPromo,
  coupon: genCoupon,
  bestsellers: genBestSellers,
  avaliacao: genAvaliacao,
};

// ─── Envio ───────────────────────────────────────────────────────────
async function publish(text, image) {
  // Carimbo de QUALQUER publicação no grupo (post ou saudação): o espaçamento
  // mínimo entre posts conta a partir dele.
  state.ultimoPostGrupo = Date.now();
  saveState();
  if (cfg.dryRun) {
    console.log(`[community] (DRY-RUN, não enviado)${image ? ` [imagem: ${image}]` : ''} →\n${text}\n`);
    return;
  }
  await sender.send(cfg.groupJid, text, {
    typing: false, // não simular "digitando" em grupo
    reaction: false,
    ...(image ? { image, imageOnly: true } : {}), // card com imagem; NÃO cai pra texto
    ...(cfg.instance ? { instance: cfg.instance } : {}),
  });
  console.log(`[community] post publicado no grupo${image ? ' (c/ imagem)' : ''}`);
}

// ─── Agendador (CADÊNCIA por tipo: cada conteúdo tem intervalo e horário) ──
/**
 * O grupo deveria estar aberto nesta hora?
 *
 * Aceita janela que cruza a meia-noite (abre 9, fecha 2), porque a alternativa
 * é alguém configurar isso um dia e descobrir que o grupo nunca mais abriu.
 */
function abertoEm(valor, abre, fecha) {
  return abre <= fecha ? valor >= abre && valor < fecha : valor >= abre || valor < fecha;
}

/**
 * Sem `minute`/`dateKey`: conta pelo horário-base (hora cheia), que é o que a
 * chamada de uma hora só consegue perguntar. Com os dois: usa o horário DO DIA,
 * o base mais o desvio sorteado (ver horariosDoPortao).
 */
function deveEstarAberto(hour, minute, dateKey) {
  if (minute == null || !dateKey) return abertoEm(hour, cfg.abreHora, cfg.fechaHora);
  const { abreMin, fechaMin } = horariosDoPortao(dateKey);
  return abertoEm(hour * 60 + minute, abreMin, fechaMin);
}

// ─── Horário do dia: base + desvio sorteado e gravado ────────────────
//
// Cada item agendado (cada post, abrir, fechar) tem um desvio em minutos por
// dia. O desvio fica em state.jitter[id][AAAA-MM-DD] e é sorteado UMA vez:
// reiniciar o bot no meio do dia devolve o mesmo horário, e nunca dá dois
// envios. O de hoje difere do de ontem em pelo menos COMMUNITY_JITTER_MIN_DIFF
// minutos (padrão 15), dentro de ±COMMUNITY_JITTER_MIN (padrão 30).
const limitarMin = (m) => Math.max(0, Math.min(1439, m));

function desvioDe(id, dateKey) {
  state.jitter = state.jitter || {};
  state.jitter[id] = state.jitter[id] || {};
  const jaTinha = Number.isFinite(state.jitter[id][dateKey]);
  const d = jitter.desvioDoDia(state.jitter[id], dateKey);
  if (!jaTinha) saveState();
  return d;
}

/** Minuto do dia (BRT) em que o grupo abre e fecha neste dia. */
function horariosDoPortao(dateKey) {
  return {
    abreMin: limitarMin(cfg.abreHora * 60 + desvioDe('portao-abre', dateKey)),
    fechaMin: limitarMin(cfg.fechaHora * 60 + desvioDe('portao-fecha', dateKey)),
  };
}

/** Minuto do dia (BRT) em que esta entrada da agenda sai neste dia. */
function horarioDoPost(item, dateKey) {
  return limitarMin(item.hour * 60 + desvioDe(`post-${item.key}@${item.hour}`, dateKey));
}

/** Folga mínima entre dois posts do grupo (qualquer tipo). */
const ESPACO_MIN_MS = Number(process.env.COMMUNITY_ESPACO_MIN ?? 20) * 60 * 1000;
/** Quanto tempo depois do horário sorteado o post ainda vale (tick perdido, espaçamento). */
const TOLERANCIA_POST_MIN = 90;

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * Deixa o portão do grupo no estado que o relógio pede.
 *
 * Só age quando o estado GRAVADO difere do desejado, ou seja, uma vez ao
 * cruzar a fronteira do horário (abre às COMMUNITY_ABRE_HORA, fecha às
 * COMMUNITY_FECHA_HORA). Se o bot estava fora do ar na hora exata, o primeiro
 * tick depois da volta conserta sozinho, e depois cala.
 *
 * Havia aqui uma reaplicação de hora em hora "por garantia". Cada chamada,
 * mesmo idempotente, faz o WhatsApp escrever no grupo "Você mudou as
 * configurações do grupo para permitir que todos os membros enviem mensagens":
 * o grupo ficava cheio dessa linha o dia inteiro. A reaplicação saiu. Se
 * alguém mexer na chavinha pelo app, o horário não briga com a pessoa; o
 * próximo cruzamento de fronteira acerta de novo.
 *
 * FALHA não é tentada a cada volta (5 min): espera um recuo crescente
 * (30 min, 1h, 1h30... até 4h), gravado no estado, que sobrevive a reinício.
 */
const RECUO_BASE_MS = 30 * 60 * 1000;
const RECUO_MAX_MS = 4 * 60 * 60 * 1000;

/**
 * Quanto tempo uma abertura/fechamento na mão segura o agendador.
 *
 * Sem isto, testar seria impossível: você abre o grupo à meia-noite pelo
 * comando e, até cinco minutos depois, o agendador fecha de novo — parecendo
 * que o comando não funcionou.
 *
 * Meia hora é tempo de testar e curto o bastante para ninguém esquecer o
 * automático desligado a noite toda. Passou, o horário volta a mandar sozinho.
 */
const MANUAL_MS = 30 * 60 * 1000;

async function ajustarPortao(hour, minute, dateKey) {
  if (!cfg.portaoLigado) return;
  if (!require('./chaves').ligada('grupo')) return;

  // Mexeram na mão agora há pouco: o agendador espera a vez dele.
  if (Date.now() < (state.portaoManualAte || 0)) return;

  const aberto = deveEstarAberto(hour, minute, dateKey);
  if (state.grupoAberto === aberto) return; // já está assim: não mexe, não gera aviso

  // Falhou há pouco: espera o recuo em vez de tentar a cada volta.
  if (Date.now() < (state.portaoTentaApos || 0)) return;

  if (cfg.dryRun) {
    console.log(`[community] (DRY-RUN) o grupo ${aberto ? 'abriria' : 'fecharia'} agora`);
    state.grupoAberto = aberto;
    state.portaoEm = Date.now();
    saveState();
    return;
  }

  try {
    await evolution.portaoDoGrupo(cfg.groupJid, aberto, cfg.instance ? { instance: cfg.instance } : {});
    state.grupoAberto = aberto;
    state.portaoEm = Date.now();
    state.portaoFalhas = 0;
    state.portaoTentaApos = 0;
    saveState();
    console.log(`[community] grupo ${aberto ? 'ABERTO' : 'FECHADO'} (base ${cfg.abreHora}h as ${cfg.fechaHora}h, com desvio do dia)`);
  } catch (err) {
    // Não propaga: o portão não pode derrubar os anúncios, que são a razão de
    // este agendador existir. O motivo já foi para o log no evolution.js.
    state.portaoFalhas = (state.portaoFalhas || 0) + 1;
    const recuo = Math.min(RECUO_BASE_MS * state.portaoFalhas, RECUO_MAX_MS);
    state.portaoTentaApos = Date.now() + recuo;
    saveState();
    console.warn(`[community] portao do grupo nao mudou, nova tentativa em ${Math.round(recuo / 60000)} min`);
  }
}

// ─── Boa noite e bom dia ─────────────────────────────────────────────
//
// Os textos moram em saudacoes.js: listas escritas à mão (mais de vinte de cada),
// sorteadas sem repetir nenhuma das últimas cinco. Antes o modelo escrevia a
// mensagem na hora e saía poesia genérica, sem cara de loja de jogo. A lista
// também não custa chamada de API nem falha.
//
// A peneira abaixo continua valendo: o teste passa todo texto da lista por ela,
// e assim ninguém acrescenta depois uma palavra barrada, um link ou um texto
// fora do tamanho.

/** Índices das últimas saudações de cada tipo, para o sorteio não repetir. */
function saudacoesRecentes(tipo) {
  const lista = state.saudacoesIdx?.[tipo];
  return Array.isArray(lista) ? lista : [];
}

function guardarSaudacao(tipo, indice) {
  state.saudacoesIdx = state.saudacoesIdx || {};
  state.saudacoesIdx[tipo] = [...saudacoesRecentes(tipo), indice].slice(-saudacoes.JANELA);
  saveState();
}

/** O que nunca pode sair, nem numa saudação. */
function saudacaoAprovada(texto) {
  const t = String(texto || '').trim();
  if (t.length < 20 || t.length > 420) return null;

  const politica = require('./ponte/politica');
  if (politica.vocabularioProibido().test(t)) return null;
  if (politica.temCJK(t)) return null;
  // Link numa saudação é propaganda disfarçada, e a mensagem perde o que ela
  // tem de melhor: não estar vendendo nada.
  if (/https?:\/\//i.test(t)) return null;

  return t;
}

/**
 * Manda a saudação do dia, se for a hora.
 *
 * `tipo` decide o texto; o horário quem decide é o chamador.
 */
async function saudar(tipo, dateKey) {
  state.slots = state.slots || {};
  const slot = `saudacao-${tipo}-${dateKey}`;
  if (state.slots[slot]) return; // já foi hoje

  const { texto, indice } = saudacoes.sortear(tipo, saudacoesRecentes(tipo));

  // A BOA NOITE avisa quando o grupo volta, e essa linha é escrita por código.
  // É informação, não poesia: quem tentar escrever meia-noite e não conseguir
  // precisa saber que não está bloqueado, só é tarde.
  const rodape =
    tipo === 'noite' && cfg.portaoLigado
      ? `\n\n${varia('noiteRodape', { h: cfg.abreHora })}`
      : '';

  state.slots[slot] = Date.now();
  guardarSaudacao(tipo, indice); // já salva o estado
  await publish(texto + rodape);
  console.log(`[community] saudacao de ${tipo} publicada`);
}

/**
 * Abre ou fecha o grupo AGORA, na mão. Para testar sem esperar o horário.
 *
 * Segura o agendador por meia hora (ver MANUAL_MS), senão a próxima volta
 * desfaria o que você acabou de fazer e pareceria que o comando não funcionou.
 *
 * @returns {Promise<{ok:boolean, erro?:string}>}
 */
async function mexerNoPortao(aberto) {
  if (!cfg.groupJid) return { ok: false, erro: 'não há grupo configurado' };

  try {
    if (!cfg.dryRun) {
      await evolution.portaoDoGrupo(cfg.groupJid, aberto, cfg.instance ? { instance: cfg.instance } : {});
    }
    state.grupoAberto = aberto;
    state.portaoEm = Date.now();
    state.portaoManualAte = Date.now() + MANUAL_MS;
    state.portaoFalhas = 0;
    state.portaoTentaApos = 0;
    saveState();
    console.log(`[community] grupo ${aberto ? 'ABERTO' : 'FECHADO'} na mao (automatico volta em 30 min)`);
    return { ok: true };
  } catch (err) {
    // O motivo CRU para quem mandou o comando. É um teste: quem está lendo quer
    // saber o que deu errado, não uma frase gentil. O erro completo já foi para
    // o log no evolution.js.
    const detalhe = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
    return { ok: false, erro: `${err.response?.status || ''} ${detalhe}`.trim() };
  }
}

/** Foto do portão, para o comando do operador. */
function estadoDoPortao() {
  const { hour, minute, dateKey } = brt(Date.now());
  const manualPor = Math.max(0, (state.portaoManualAte || 0) - Date.now());
  const { abreMin, fechaMin } = horariosDoPortao(dateKey);
  return {
    ligado: cfg.portaoLigado && Boolean(cfg.groupJid),
    temGrupo: Boolean(cfg.groupJid),
    aberto: state.grupoAberto,
    deveriaEstarAberto: deveEstarAberto(hour, minute, dateKey),
    abreHora: cfg.abreHora,
    fechaHora: cfg.fechaHora,
    abreHoje: hhmm(abreMin),
    fechaHoje: hhmm(fechaMin),
    agora: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    manualPorMin: Math.round(manualPor / 60000),
  };
}

/** Para o #status: o grupo está fechado neste instante? */
function grupoFechado() {
  if (!cfg.portaoLigado || !cfg.groupJid) return false;
  const { hour, minute, dateKey } = brt(Date.now());
  return !deveEstarAberto(hour, minute, dateKey);
}

async function tick() {
  if (running || !cfg.enabled || !cfg.groupJid) return;
  running = true;
  try {
    const now = Date.now();
    // `minute` faltava aqui, e o arquivo é 'use strict': a saudação lia uma
    // variável que não existia e o tick inteiro morria com ReferenceError, todo
    // ciclo, calado dentro do catch lá embaixo. O bom dia nunca teve chance.
    const { hour, minute, dateKey } = brt(now);

    // Estas duas linhas vinham DEPOIS das saudações, e `saudar` lê state.slots.
    // Num estado recém-criado (deploy que apaga o arquivo) seria outro erro no
    // mesmo lugar. Inicializar antes de qualquer coisa que use é mais barato
    // que lembrar da ordem.
    state.lastPostAt = state.lastPostAt || {};
    state.slots = state.slots || {};

    // ANTES dos anúncios, de propósito: se o horário de abrir chegou, o grupo
    // abre nesta volta e o anúncio das 10h já cai num grupo aberto.
    await ajustarPortao(hour, minute, dateKey);

    // ── As saudações ──────────────────────────────────────
    //
    // A BOA NOITE sai na hora de fechar, e vem DEPOIS do ajustarPortao acima:
    // assim ela é a última mensagem do dia, e ninguém escreve por cima dela.
    //
    // O BOM DIA sai cinco minutos ANTES de abrir, com o grupo ainda fechado —
    // por isso ele fica sozinho no topo quando as pessoas voltam, em vez de
    // nascer no meio de uma conversa. Só o bot escreve num grupo fechado, e ele
    // é admin (é o que faz o portão funcionar).
    //
    // A janela vai até a hora de abrir, e não só nos cinco minutos: um tick
    // perdido não pode custar a saudação do dia. A trava de slot cuida do resto.
    if (cfg.saudacoesLigadas && require('./chaves').ligada('grupo')) {
      // Abrir e fechar têm horário DO DIA (base + desvio gravado), e as
      // saudações andam junto com eles.
      const { abreMin: minutoDeAbrir, fechaMin: minutoDeFechar } = horariosDoPortao(dateKey);
      const agoraEmMinutos = hour * 60 + minute;
      const janelaDoBomDia =
        agoraEmMinutos >= minutoDeAbrir - cfg.antecedenciaBomDiaMin &&
        agoraEmMinutos < minutoDeAbrir + 60;
      const janelaDaBoaNoite =
        agoraEmMinutos >= minutoDeFechar && agoraEmMinutos < minutoDeFechar + 60;

      if (janelaDaBoaNoite) await saudar('noite', dateKey);
      else if (janelaDoBomDia) await saudar('dia', dateKey);
    }
    // Poda slots antigos (mantém o estado enxuto).
    for (const k of Object.keys(state.slots)) {
      if (now - state.slots[k] > 15 * 24 * 60 * 60 * 1000) delete state.slots[k];
    }

    for (const item of cfg.schedule) {
      // Cada entrada posta no SEU horário DO DIA: base + desvio sorteado (±30 min,
      // diferente do de ontem). Vale por 90 min, para um tick perdido ou o
      // espaçamento não custarem o post.
      const agoraMin = hour * 60 + minute;
      const quando = horarioDoPost(item, dateKey);
      if (agoraMin < quando || agoraMin >= quando + TOLERANCIA_POST_MIN) continue;
      // Grupo fechado pelo horário: não anuncia para ninguém (nem antes de abrir
      // nem depois de fechar).
      if (cfg.portaoLigado && !deveEstarAberto(hour, minute, dateKey)) continue;
      const entryId = `${item.key}@${item.hour}`;   // por HORÁRIO → permite 2/dia do mesmo tipo
      const slotKey = `${entryId}-${dateKey}`;      // no máx 1 dessa entrada por dia
      if (state.slots[slotKey]) continue;           // já postou hoje nesse horário
      const last = state.lastPostAt[entryId] || 0;
      const dueMs = (item.everyDays - 0.5) * 24 * 60 * 60 * 1000; // tolerância de meio dia
      if (last && now - last < dueMs) continue;     // ainda não completou a cadência
      // Espaçamento: nada de dois envios colados no grupo. Fica para o próximo tick.
      if (now - (state.ultimoPostGrupo || 0) < ESPACO_MIN_MS) break;

      const gen = GENERATORS[item.key];
      if (!gen) continue;
      let result = null;
      try { result = await gen(); }
      catch (err) { console.error(`[community] gerador ${item.key} falhou:`, err.response?.status || err.message); }
      const text = typeof result === 'string' ? result : (result && result.text);
      const image = typeof result === 'string' ? null : (result && result.image);
      if (!text) continue; // sem conteúdo agora → tenta no próximo tick/dia

      // Marca ANTES de publicar (otimista) p/ não duplicar entre ticks/reinícios.
      state.slots[slotKey] = now;
      state.lastPostAt[entryId] = now;
      saveState();
      await publish(text, image);
      console.log(`[community] postado "${item.key}" (cada ${item.everyDays}d @${item.hour}h)`);
      break; // um post por tick
    }
  } catch (err) {
    console.error('[community] erro no tick:', err.message);
  } finally {
    running = false;
  }
}

// ─── O BOT NAO RESPONDE NO GRUPO. NUNCA. ────────────────────
//
// Aqui existia o caminho inverso: mensagem do grupo entrava, ia para a IA, e a
// resposta era publicada la. Ficava atras de COMMUNITY_REPLY_ENABLED, desligado
// por padrao.
//
// O dono fechou a questao: as unicas mensagens que saem para o grupo sao os
// anuncios que este arquivo agenda. Conversa e no privado.
//
// Um interruptor desligado nao implementa "nunca" -- implementa "ate alguem
// ligar", e quem ligar daqui a seis meses nao vai saber que existia uma regra.
// Por isso o caminho saiu inteiro, junto com COMMUNITY_REPLY_ENABLED,
// COMMUNITY_TRIGGER, COMMUNITY_BOT_NUMBER e o cooldown que so ele usava.
//
// O que sobrou e so saida: tick() publica, e ninguem le o grupo. O server nem
// entrega mais mensagem de grupo para ca.

function start() {
  if (!cfg.enabled) { console.log('[community] desligada (COMMUNITY_ENABLED != true)'); return; }
  if (!cfg.groupJid) { console.log('[community] SEM COMMUNITY_GROUP_JID — não vai postar'); return; }
  if (timer) return;
  const agenda = cfg.schedule.map((s) => `${s.key} a cada ${s.everyDays}d @${s.hour}h(±${jitter.FAIXA}min)`).join(', ') || '(vazia)';
  console.log(
    `[community] ligada — grupo ${cfg.groupJid}${cfg.instance ? ` (instância ${cfg.instance})` : ''}; ` +
    `agenda: ${agenda} (BRT); ${cfg.dryRun ? 'DRY-RUN' : 'AO VIVO'}`
  );
  timer = setInterval(tick, cfg.checkIntervalMs);
  if (timer.unref) timer.unref();

  // Force-post imediato (uma vez), p/ teste: COMMUNITY_FORCE_NOW="reviews,news".
  // Ignora cadência/slot (mas respeita dry-run). Remova a env depois de usar.
  const force = String(process.env.COMMUNITY_FORCE_NOW || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (force.length) {
    (async () => {
      for (const key of force) {
        const gen = GENERATORS[key];
        if (!gen) { console.warn(`[community] FORCE: gerador "${key}" não existe`); continue; }
        try {
          const result = await gen();
          const text = typeof result === 'string' ? result : (result && result.text);
          const image = typeof result === 'string' ? null : (result && result.image);
          if (text) { await publish(text, image); console.log(`[community] FORCE post "${key}"`); }
          else console.warn(`[community] FORCE: "${key}" sem conteúdo`);
        } catch (err) { console.error(`[community] FORCE "${key}" falhou:`, err.message); }
      }
    })();
  }
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

// A peneira das saudações vai exportada para o teste: é ela que decide o que de
// texto GERADO chega num grupo de centenas de pessoas sem ninguém ler antes.
// Sem alcançá-la, o teste dublaria justamente o que deveria estar medindo.
module.exports = { start, stop, tick, ajustarPortao, grupoFechado, deveEstarAberto, horariosDoPortao, horarioDoPost, TEXTOS, varia, _estado: () => state, saudacaoAprovada, saudar, mexerNoPortao, estadoDoPortao, genBestSellers, genPromo, genCoupon, genNews, genReviews, genAvaliacao };
