'use strict';

/**
 * Pedido de código pelo SITE (phaze-codigo), sem passar pelo WhatsApp.
 *
 *   site  ->  painel de estoque /codigo/*  ->  aqui (/web/*)
 *
 * O painel já chamava estas rotas e elas não existiam: o site mostrava
 * "manutenção" o tempo todo e nenhum pedido chegava à fila.
 *
 * O cliente do site entra na MESMA fila serial do WhatsApp, como um contato
 * virtual `web:<24 hex>`. Isso é o ponto: a fila serial é o que garante de quem
 * é o código que volta (fila.js:9-14), e um segundo caminho de envio seria um
 * segundo lugar para errar isso. Daqui para frente o braço, o copiloto (#ok),
 * o #enviar, a expiração e o congelamento funcionam sem saber que existe site.
 *
 * O que muda é só a SAÍDA: tudo o que seria mandado ao `web:...` pelo sender
 * fica guardado numa caixa de entrada (`dados.web`), e o site lê dali.
 *
 * Só o painel fala com estas rotas (x-painel-chave = PAINEL_BOT_CHAVE). Os
 * limites por IP e por login ficam no painel, que é quem vê o IP do cliente.
 */

const crypto = require('crypto');
const express = require('express');
const cfg = require('./config');
const fila = require('./fila');
const limites = require('./limites');
const janela = require('./janela');
const midia = require('./midia');
const codigo = require('./codigo');
const { dados, persist, persistAgora } = require('./estado');
const sender = require('../sender');
const painelEstoque = require('../painel-estoque');

const PREFIXO = 'web:';
const ID_VALIDO = /^web:[0-9a-f]{24}$/;

/** Quanto o POST espera a fila responder antes de devolver ao painel. O painel desiste em 20 s. */
const ESPERA_PEDIDO_MS = Number(process.env.WEB_ESPERA_PEDIDO_MS) || 6000;
/** Registro sem atendimento depois disto: o pedido se perdeu no caminho. */
const SEM_ATENDIMENTO_MS = 90 * 1000;
const GUARDA_MS = 2 * 24 * 60 * 60 * 1000;

const MSG_MANUTENCAO = 'O sistema de códigos está em manutenção agora. Tente de novo em alguns minutos.';
const MSG_FALHOU = 'Não consegui registrar seu pedido agora. Toque em *Pedir outro código* e tente de novo.';

const ehWeb = (from) => String(from || '').startsWith(PREFIXO);

function registro(id, criar) {
  if (!dados.web || typeof dados.web !== 'object') dados.web = {};
  let r = dados.web[id];
  if (!r && criar) {
    r = { criadoEm: Date.now(), mensagens: [] };
    dados.web[id] = r;
  }
  return r || null;
}

function podar(agora = Date.now()) {
  if (!dados.web) return;
  for (const [id, r] of Object.entries(dados.web)) {
    if (!r || agora - (r.criadoEm || 0) > GUARDA_MS) delete dados.web[id];
  }
}

/**
 * Adapta ao site um texto escrito para o WhatsApp.
 *
 * O fluxo manda o cliente "digitar #inicio" para recomeçar. No site não há
 * onde digitar: o caminho é o botão. A assinatura também sai, porque a página
 * já é da marca e ela apareceria embaixo de toda mensagem.
 */
function paraSite(texto) {
  const maiuscula = (m, s) => (/^[A-ZÁÉÍÓÚ]/.test(m) ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  return sender
    .normalizeWhatsApp(texto)
    .replace(/\n*_Phaze Games_\s*🎮?\s*$/u, '')
    .replace(/\b(?:mandar|digitar)\s+\*?#inicio\*?(?:\s+aqui)?/gi, 'tocar em *Pedir outro código*')
    .replace(/\b(?:manda|mande|digita|digite)\s+\*?#inicio\*?(?:\s+aqui)?(?:\s+e\s+pede\s+de\s+novo)?/gi, (m) => maiuscula(m, 'toque em *Pedir outro código*'))
    .replace(/\*?#inicio\*?/gi, '*Pedir outro código*')
    .trim();
}

/**
 * A porta que o sender usa para um destino `web:`. Nada vai ao WhatsApp.
 * Resolve na hora: no site não existe "digitando", e segurar aqui só atrasaria
 * a fila de quem chama.
 */
function guardar(id, texto) {
  const r = registro(id, true);
  const limpo = paraSite(texto);
  if (limpo) {
    r.mensagens.push({ texto: limpo, em: Date.now() });
    if (r.mensagens.length > 30) r.mensagens = r.mensagens.slice(-30);
    persist();
  }
  return Promise.resolve(true);
}

function ligado() {
  return Boolean(cfg.ativa && require('./index').ativa());
}

function atendimentoDo(id) {
  let achado = null;
  for (const a of dados.atendimentos) if (a.from === id) achado = a;
  return achado;
}

/** Quantos estão na frente: o atendimento em curso mais os que chegaram antes. */
function naFrente(at) {
  const s = fila.situacao();
  const antes = s.aguardando.findIndex((x) => x.id === at.id);
  return Math.max(1, (s.ativo ? 1 : 0) + Math.max(0, antes));
}

function geral() {
  const j = janela.estado();
  return {
    congelado: limites.disjuntor().estado === 'aberto',
    janelaAberta: j.aberta,
    proximaAbertura: j.aberta ? null : j.proximaAbertura.getTime(),
  };
}

/** O que o site precisa para desenhar a tela do pedido. */
function situacao(id) {
  const r = registro(id, false);
  const at = atendimentoDo(id);
  const base = { ok: true, id, ...geral(), mensagens: r ? r.mensagens : [] };

  if (!at) {
    if (r && r.recusado) return { ...base, estado: 'recusado' };
    if (r && Date.now() - r.criadoEm < SEM_ATENDIMENTO_MS) return { ...base, estado: 'enviando' };
    return {
      ...base,
      estado: 'expirado',
      mensagens: [...base.mensagens, { texto: 'Não encontrei esse pedido. Toque em *Pedir outro código* para pedir de novo.', em: Date.now() }],
    };
  }

  if (at.estado === 'aguardando') return { ...base, estado: 'aguardando', posicao: naFrente(at) };
  if (at.estado === 'ativo') return { ...base, estado: 'ativo' };
  if (at.codigo) return { ...base, estado: 'concluido', codigo: at.codigo };
  if (at.estado === 'expirado') return { ...base, estado: 'expirado' };

  // Concluído sem código e sem nenhuma palavra no fim (o #pular, por exemplo):
  // sem esta linha a tela diria "leia a mensagem abaixo" em cima de nada. O
  // minuto de folga é porque o aviso de retorno sai um instante ANTES de a vez
  // ser encerrada (receberDoFornecedor).
  const falouDepois = base.mensagens.some((m) => m.em >= (at.concluidoEm || 0) - 60 * 1000);
  if (!falouDepois) {
    return {
      ...base,
      estado: 'concluido',
      mensagens: [...base.mensagens, { texto: 'Nossa equipe está conferindo o seu pedido. Deixe esta página aberta: a resposta aparece aqui.', em: Date.now() }],
    };
  }
  return { ...base, estado: 'concluido' };
}

/** JPEG, PNG ou WEBP de verdade, pelos primeiros bytes. */
function imagemValida(base64) {
  if (base64.length < 1000) return false;
  const b = Buffer.from(base64.slice(0, 64), 'base64');
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const webp = b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP';
  return jpeg || png || webp;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const router = express.Router();

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const recebida = Buffer.from(String(req.get('x-painel-chave') || ''));
  const esperada = Buffer.from(painelEstoque.chave());
  if (!esperada.length) return res.status(503).json({ ok: false, erro: 'PAINEL_BOT_CHAVE não configurada no bot.' });
  if (recebida.length !== esperada.length || !crypto.timingSafeEqual(recebida, esperada)) {
    console.warn('[web] chamada RECUSADA: chave errada (PAINEL_BOT_CHAVE do bot diferente da BOT_CHAVE do painel?)');
    return res.status(401).json({ ok: false, erro: 'Acesso negado.' });
  }
  next();
});

router.get('/estado', (_req, res) => {
  const s = fila.situacao();
  let naEntrada = 0;
  try { naEntrada = require('./recepcao').esperandoVez().length; } catch { /* sem recepção, conta só a fila */ }
  res.json({ ok: true, ligado: ligado(), ...geral(), naFila: (s.ativo ? 1 : 0) + s.aguardando.length + naEntrada });
});

router.post('/codigo', async (req, res) => {
  const b = req.body || {};
  const recusa = (mensagem) => res.json({ ok: true, aceito: false, id: null, mensagem });

  try {
    if (!ligado()) return recusa(MSG_MANUTENCAO);

    const v = codigo.validarUsuario(String(b.login || '').trim());
    if (!v.valido) {
      return recusa('Confira o login: coloque só o login da conta, igual aparece na tela, sem espaços (algo como *rrrtsr223*).');
    }

    const foto = String(b.imagemBase64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!imagemValida(foto)) return recusa('Não consegui abrir a foto. Tire outra foto da tela do console e tente de novo.');

    // A mesma conta já tem pedido andando. Dois pedidos iguais seriam o mesmo
    // print e o mesmo login saindo duas vezes para o outro lado, e o segundo
    // código invalidaria o primeiro. Pedido do site devolve o mesmo id (foi o
    // cliente que tocou duas vezes ou recarregou); pedido do WhatsApp não é dele.
    const login = v.usuario.toLowerCase();
    const aberto = dados.atendimentos.find(
      (a) => (a.estado === 'aguardando' || a.estado === 'ativo') && String(a.usuario || '').toLowerCase() === login,
    );
    if (aberto) {
      if (ehWeb(aberto.from)) return res.json({ ok: true, aceito: true, id: aberto.from, mensagem: '', situacao: situacao(aberto.from) });
      return recusa('Essa conta já tem um pedido de código em andamento. Espere ele terminar antes de pedir outro.');
    }

    const id = PREFIXO + crypto.randomBytes(12).toString('hex');
    podar();
    registro(id, true);
    persistAgora();

    const mimetype = /^image\/(jpeg|png|webp)$/.test(b.mimetype) ? b.mimetype : 'image/jpeg';
    const imagem = await midia.salvar(foto, mimetype);
    const nome = String(b.nome || 'Site').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Site';

    // O pedido segue sozinho e o painel recebe a resposta antes. No copiloto o
    // pedirCodigo espera o alerta do operador sair pelo WhatsApp, e o ritmo
    // humanizado leva dezenas de segundos: o painel desistiria antes e o
    // cliente pediria de novo um pedido que já existe.
    const corrida = require('./index')
      .pedirCodigo(id, nome, v.usuario, imagem)
      .then((r) => {
        if (r && r.mensagem) guardar(id, r.mensagem);
        if (!r || !r.aceito) {
          registro(id, true).recusado = true;
          persist();
        }
        return r;
      })
      .catch((err) => {
        console.error(`[web] pedido ${id} falhou:`, err.message);
        if (!atendimentoDo(id)) {
          registro(id, true).recusado = true;
          guardar(id, MSG_FALHOU);
        }
        return null;
      });

    const r = await Promise.race([corrida, dormir(ESPERA_PEDIDO_MS).then(() => 'esperando')]);
    if (r !== 'esperando' && (!r || !r.aceito) && !atendimentoDo(id)) {
      return recusa(paraSite((r && r.mensagem) || MSG_FALHOU));
    }

    console.log(`[web] pedido ${id} na fila`);
    res.json({ ok: true, aceito: true, id, mensagem: '', situacao: situacao(id) });
  } catch (err) {
    console.error('[web] erro no pedido:', err.message);
    res.status(500).json({ ok: false, erro: 'Não deu para pedir agora. Tente de novo em instantes.' });
  }
});

router.get('/codigo/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!ID_VALIDO.test(id)) return res.status(400).json({ ok: false, erro: 'Pedido inválido.' });
  res.json(situacao(id));
});

module.exports = { router, ehWeb, guardar, paraSite, situacao };
