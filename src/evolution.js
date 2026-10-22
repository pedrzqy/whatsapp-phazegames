'use strict';

/**
 * Cliente da Evolution API para ENVIAR mensagens ao WhatsApp.
 * Docs: https://docs.evolutionfoundation.com.br/evolution-api
 * Autenticação: header `apikey` (chave global da instância).
 */

const axios = require('axios');
const config = require('./config');

const http = axios.create({
  baseURL: config.evolution.url,
  timeout: 20000,
  headers: {
    apikey: config.evolution.apiKey,
    'Content-Type': 'application/json',
  },
});

/**
 * Normaliza o destino para o formato esperado pela Evolution.
 * - Número BR ("5541999999999" ou "+55 (41) 99999-9999") → só dígitos.
 * - JID (contém "@", ex.: grupo "...@g.us") → usado como veio (NÃO remover dígitos/traços).
 */
function toNumber(raw) {
  const s = String(raw);
  return s.includes('@') ? s : s.replace(/\D/g, '');
}

// ── Número estrangeiro: descobrir o JID de verdade ───────────
//
// O Brasil tem a regra do nono dígito e a Evolution a resolve sozinha. O México
// não: um celular já foi 521 + 10 dígitos e hoje é 52 + 10, e o checkout, o
// webhook e a conversa trazem as duas formas. Mandar para a errada = mensagem
// que não chega, sem erro. Então, fora do Brasil, pergunta-se ao WhatsApp
// (`/chat/whatsappNumbers`, o onWhatsApp) qual das formas existe e usa-se o
// JID que ele devolve. O resultado fica em cache: é uma ida a mais só na
// primeira mensagem para o número.
const CACHE_ACHOU_MS = 24 * 3600 * 1000;
const CACHE_NAO_ACHOU_MS = 5 * 60 * 1000;
const cacheJid = new Map(); // `${instancia}:${digitos}` → { numero, ate }

/** Formas a testar no onWhatsApp para um número sem JID conhecido. */
function candidatos(digitos) {
  return require('./telefone').formasDoNumero(digitos);
}

/**
 * Número (ou JID) → destino que a Evolution aceita. Brasil, grupos e qualquer
 * coisa com @ passam direto, como sempre; só número estrangeiro é consultado.
 * Falha na consulta NUNCA impede o envio: usa o número como veio.
 */
async function destino(raw, instance) {
  const direto = toNumber(raw);
  if (direto.includes('@')) return direto;
  if (direto.length < 10 || direto.startsWith('55')) return direto;

  const chave = `${instance}:${direto}`;
  const hit = cacheJid.get(chave);
  if (hit && hit.ate > Date.now()) return hit.numero;

  const lista = candidatos(direto);
  try {
    const { data } = await http.post(`/chat/whatsappNumbers/${instance}`, { numbers: lista });
    const achados = Array.isArray(data) ? data : data?.data || [];
    // Respeita a ordem dos candidatos: a forma atual (52 + 10) primeiro.
    for (const c of lista) {
      const r = achados.find((x) => x && x.exists && (String(x.number || '').replace(/\D/g, '') === c ||
        String(x.jid || '').split('@')[0] === c));
      if (r) {
        const numero = String(r.jid || r.number || c).split('@')[0].replace(/\D/g, '') || c;
        cacheJid.set(chave, { numero, ate: Date.now() + CACHE_ACHOU_MS });
        return numero;
      }
    }
    // Nenhuma existe: manda como veio e lembra por pouco tempo.
    cacheJid.set(chave, { numero: direto, ate: Date.now() + CACHE_NAO_ACHOU_MS });
  } catch (err) {
    console.warn(`[evolution] whatsappNumbers falhou para ${direto}: ${err.response?.status || err.message}`);
  }
  return direto;
}

/** Envia uma mensagem de texto simples. `opts.instance` permite outra instância (ex.: comunidade). */
async function sendText(number, text, opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.post(`/message/sendText/${instance}`, {
    number: await destino(number, instance),
    text,
  });
  return data;
}

/**
 * Define o "presence" da conversa (ex: 'composing' = digitando...).
 * Deixa o atendimento com cara de humano. Valores: 'composing' | 'paused' |
 * 'recording' | 'available' | 'unavailable'.
 */
async function sendPresence(number, presence = 'composing', opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.post(`/chat/sendPresence/${instance}`, {
    number: await destino(number, instance),
    presence,
  });
  return data;
}

/**
 * Todos os grupos de que o número participa (id + nome).
 * Serve para achar o grupo da equipe pelo NOME, sem o dono caçar JID.
 */
async function fetchAllGroups(opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.get(`/group/fetchAllGroups/${instance}`, {
    params: { getParticipants: 'false' },
    timeout: 15000,
  });
  return Array.isArray(data) ? data : [];
}

/**
 * Dados do grupo: nome, nº de participantes e se o NOSSO número é admin.
 * `souAdmin` é null quando não deu para descobrir o nosso número.
 */
async function infoDoGrupo(groupJid, opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.get(`/group/findGroupInfos/${instance}`, {
    params: { groupJid },
    timeout: 15000,
  });
  const g = Array.isArray(data) ? data[0] : data;
  if (!g) throw new Error('grupo não encontrado');
  const lista = Array.isArray(g.participants) ? g.participants : [];

  // Nosso número: a Evolution v2 devolve ownerJid em fetchInstances.
  let meu = null;
  try {
    const r = await http.get('/instance/fetchInstances', { params: { instanceName: instance }, timeout: 15000 });
    const inst = Array.isArray(r.data) ? r.data[0] : r.data;
    meu = String(inst?.ownerJid || inst?.instance?.owner || inst?.number || '').split('@')[0].split(':')[0] || null;
  } catch { /* sem o número, souAdmin fica null */ }

  let souAdmin = null;
  if (meu && lista.length) {
    const eu = lista.find((p) => String(p.id || p.jid || p.phoneNumber || '').split('@')[0].split(':')[0] === meu
      || String(p.phoneNumber || '').split('@')[0] === meu);
    souAdmin = eu ? Boolean(eu.admin) : false;
  }
  return {
    nome: g.subject || g.name || '',
    tamanho: lista.length || (Number.isFinite(g.size) ? g.size : null),
    souAdmin,
  };
}

/** Link de convite do grupo (https://chat.whatsapp.com/…). Exige ser admin. */
async function linkDoGrupo(groupJid, opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.get(`/group/inviteCode/${instance}`, {
    params: { groupJid },
    timeout: 15000,
  });
  const direto = data?.inviteUrl || data?.url;
  if (direto) return String(direto);
  const codigo = data?.inviteCode || data?.code;
  if (codigo) return `https://chat.whatsapp.com/${codigo}`;
  throw new Error('a Evolution não devolveu o link');
}

/**
 * Quantos participantes tem o grupo, ou null se não deu para saber.
 * Serve ao resumo do dia (membros novos = diferença entre dois retratos).
 */
async function contarParticipantes(groupJid, opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  try {
    const { data } = await http.get(`/group/participants/${instance}`, {
      params: { groupJid },
      timeout: 15000,
    });
    const lista = Array.isArray(data) ? data : data?.participants;
    if (Array.isArray(lista)) return lista.length;
  } catch { /* cai para a listagem completa abaixo */ }
  try {
    const { data } = await http.get(`/group/fetchAllGroups/${instance}`, {
      params: { getParticipants: 'true' },
      timeout: 30000,
    });
    const g = (Array.isArray(data) ? data : []).find((x) => x.id === groupJid);
    if (g && Array.isArray(g.participants)) return g.participants.length;
    if (g && Number.isFinite(g.size)) return g.size;
  } catch { /* sem dado */ }
  return null;
}

/**
 * O WhatsApp está conectado?
 *
 * Devolve o estado cru da instância ('open' = conectado). Serve ao #status: se
 * o aparelho caiu, TODA mensagem some em silêncio — e o sintoma que chega é
 * "o bot parou", que aponta para o lugar errado.
 */
async function estadoInstancia(opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.get(`/instance/connectionState/${instance}`);
  return data?.instance?.state || data?.state || '';
}

/**
 * Pede um código de pareamento novo para reconectar o número.
 *
 * Quando o WhatsApp cai, o bot fica mudo e NÃO consegue avisar ninguém: o único
 * canal que ele tem é justamente o que caiu. E o painel da Evolution mora num
 * endereço interno do Easypanel, que o navegador de fora não resolve.
 *
 * Sobrava o console do container, digitando um comando comprido no celular. É
 * o pior momento possível para exigir isso de alguém: a loja está parada.
 *
 * @returns {Promise<{pairingCode:string|null, qrBase64:string|null}>}
 */
async function conectarInstancia(opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.get(`/instance/connect/${instance}`);
  // `base64` às vezes já vem como data URI e às vezes cru, dependendo da versão
  // da Evolution. Normalizar aqui evita uma imagem quebrada na única tela que
  // alguém abre no meio de um problema.
  const bruto = data?.base64 || data?.qrcode?.base64 || null;
  return {
    pairingCode: data?.pairingCode || data?.qrcode?.pairingCode || null,
    qrBase64: bruto && !bruto.startsWith('data:') ? `data:image/png;base64,${bruto}` : bruto,
  };
}

/**
 * Abre ou fecha o grupo para mensagens de quem não é admin.
 *
 * `announcement` é o nome do WhatsApp para "só administradores enviam". É a
 * mesma chavinha do app, e o número do bot PRECISA ser admin do grupo — sem
 * isso a API aceita a chamada e nada acontece, que é o tipo de falha que passa
 * despercebida por semanas.
 *
 * @param {string} groupJid  o grupo (…@g.us)
 * @param {boolean} aberto   true = todo mundo escreve; false = só admin
 */
async function portaoDoGrupo(groupJid, aberto, opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const action = aberto ? 'not_announcement' : 'announcement';
  try {
    const { data } = await http.post(
      `/group/updateSetting/${instance}`,
      { action },
      { params: { groupJid } },
    );
    return data;
  } catch (err) {
    // O CORPO do erro, não só o status. A rota de grupo muda de nome entre
    // versões da Evolution, e um 404 sem corpo não diz se o caminho está errado,
    // se o grupo não existe ou se o bot não é admin — três consertos diferentes.
    const detalhe = err.response?.data
      ? JSON.stringify(err.response.data).slice(0, 300)
      : err.message;
    console.error(`[evolution] portao do grupo (${action}) falhou ${err.response?.status || ''}: ${detalhe}`);
    throw err;
  }
}

/**
 * Envia um menu como LISTA nativa do WhatsApp.
 *
 * Lista e não botão: o WhatsApp aceita no máximo 3 botões de resposta, e o
 * menu principal da loja tem 8 opções. Cortar para 3 seria esconder metade do
 * atendimento atrás de um "ver mais".
 *
 * Quem chama precisa estar pronto para isto FALHAR. Lista e botão passam pelo
 * Baileys, que reimplementa um formato não documentado do WhatsApp: o suporte
 * muda entre versões da Evolution e some sem aviso. Por isso nada aqui tem
 * fallback interno — o sender.js decide, e ele cai no menu de texto numerado,
 * que sempre funcionou.
 *
 * `rowId` de cada linha é o NÚMERO da opção. Assim, venha a resposta do
 * WhatsApp como id da linha ou como texto do título, o menu resolve pelo mesmo
 * caminho de quem digitou "3" na mão.
 */
async function sendList(number, { title, description, buttonText, footer, rows }, opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.post(`/message/sendList/${instance}`, {
    number: await destino(number, instance),
    title,
    description,
    buttonText,
    footerText: footer,
    sections: [{ title: buttonText || 'Opções', rows }],
  });
  return data;
}

/** Envia mídia (imagem/documento) por URL. `opts.instance` permite outra instância. */
async function sendMedia(number, { mediatype, mimetype, media, caption, fileName }, opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.post(`/message/sendMedia/${instance}`, {
    number: await destino(number, instance),
    mediatype, // 'image' | 'document' | 'video'
    ...(mimetype ? { mimetype } : {}),
    media, // URL ou base64
    caption,
    fileName,
  }, {
    // Vídeo em base64 passa dos 7 MB: o timeout de 20s do cliente não basta.
    timeout: mediatype === 'video' ? 120000 : undefined,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return data;
}

/**
 * Baixa a mídia de uma mensagem RECEBIDA e devolve em base64.
 *
 * O webhook da Evolution entrega só os metadados da imagem (mimetype, tamanho,
 * chaves de criptografia) — o binário fica no servidor do WhatsApp. Esta rota
 * pede à Evolution que baixe e descriptografe por nós.
 *
 * @param {object} rawMessage  o objeto `data` do webhook (precisa ter .key e .message)
 * @param {{instance?:string}} [opts]
 * @returns {Promise<{base64:string, mimetype:string, fileName?:string}>}
 */
async function getBase64FromMediaMessage(rawMessage, opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.post(`/chat/getBase64FromMediaMessage/${instance}`, {
    message: rawMessage,
    convertToMp4: false,
  });
  return data;
}

module.exports = {
  http,
  toNumber,
  destino,
  _cacheJid: cacheJid,
  sendText,
  sendPresence,
  sendMedia,
  sendList,
  estadoInstancia,
  conectarInstancia,
  portaoDoGrupo,
  fetchAllGroups,
  contarParticipantes,
  infoDoGrupo,
  linkDoGrupo,
  getBase64FromMediaMessage,
};
