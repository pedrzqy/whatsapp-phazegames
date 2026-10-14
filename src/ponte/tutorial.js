'use strict';

/**
 * Pós-código: vídeo do passo a passo de instalação e pedido de avaliação no
 * grupo oficial.
 *
 * Disparado por entregarCodigo DEPOIS de o código ter saído para o cliente (se
 * o envio falhou ou foi para o operador, nem chega aqui). Roda solto — fire and
 * forget: nada daqui atrasa a entrega nem a vez do próximo. Qualquer falha vira
 * log, e o texto de avaliação sai mesmo se o vídeo falhar.
 *
 * Uma vez por atendimento: a marca fica no próprio atendimento (persistida
 * junto com ele) e também num Set em memória, que fecha a janela entre dois
 * disparos no mesmo tick.
 */

const cfg = require('./config');
const humaniza = require('./humaniza');
const variantes = require('./variantes');
const exemplo = require('../exemplo');

// 3 formas de cada texto (variantes.js). A legenda do vídeo fica profissional;
// o pedido de avaliação segue carinhoso. A #1 de cada é o texto original.
const VARIANTES_VIDEO = [
  '*Tutorial de instalação* 🎮\n\n' +
    'Seu código foi entregue com sucesso. ✅\n\n' +
    'Assista ao vídeo e siga o passo a passo para concluir a instalação do jogo no seu Nintendo Switch.\n\n' +
    'Em caso de dúvida, é só responder por aqui.',
  '*Tutorial de instalação* 🎮\n\n' +
    'Código entregue com sucesso. ✅\n\n' +
    'Assista ao vídeo e siga o passo a passo para instalar o jogo no seu Nintendo Switch.\n\n' +
    'Qualquer dúvida, é só responder por aqui.',
  '*Tutorial de instalação* 📲\n\n' +
    'Seu código foi entregue. ✅\n\n' +
    'Siga o passo a passo do vídeo para concluir a instalação no seu Nintendo Switch.\n\n' +
    'Se precisar de ajuda, estamos à disposição.',
];
const MSG_VIDEO = VARIANTES_VIDEO[0];

const VARIANTES_AVALIACAO = [
  'Ahh, e uma coisinha 💚\n\n' +
    'Se deu tudo certo e você curtiu, deixa uma *avaliação* lá no nosso *grupo oficial*? ' +
    'Pode ser um print do jogo rodando, uma foto ou só umas palavrinhas.\n\n' +
    'Ainda não tá no grupo? Me pede aqui que eu te adiciono rapidinho! Lá sempre rola *cupom de desconto*. 🎁\n\n' +
    'Bom jogo! 🎮',
  'Uma coisinha antes de ir.\n\n' +
    'Deu tudo certo? Deixa uma *avaliação* no nosso *grupo oficial*! ' +
    'Pode ser um print do jogo rodando ou só umas palavrinhas. ⭐\n\n' +
    'Ainda não tá no grupo? Me pede aqui que eu te adiciono rapidinho, lá sempre rola *cupom de desconto*. 🎁\n\n' +
    'Bom jogo! 💚',
  'Ahh, antes que eu esqueça.\n\n' +
    'Se você curtiu, deixa uma *avaliação* no *grupo oficial*? ' +
    'Um print ou umas palavrinhas já ajudam muito. 🙏\n\n' +
    'Ainda sem grupo? Me fala que eu te adiciono rapidinho, tem *cupom de desconto* lá. 🎁\n\n' +
    'Bom jogo! 💚',
];

function mensagemAvaliacao(destino) {
  return variantes.escolher('avaliacao', VARIANTES_AVALIACAO, destino);
}

const jaEnviado = new Set();

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function enviar(atendimento) {
  try {
    const video = exemplo.tutorialInstalacao();
    if (video) {
      await humaniza.enviar(atendimento.from, variantes.escolher('video', VARIANTES_VIDEO, atendimento.from), { video, fileName: 'tutorial-instalacao.mp4' });
    } else {
      console.warn('[ponte] tutorial: vídeo indisponível — mando só o pedido de avaliação');
    }
  } catch (err) {
    const detalhe = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
    console.warn(`[ponte] tutorial: vídeo falhou para ${atendimento.from}: ${detalhe}`);
  }

  try {
    if (cfg.tutorialAvaliacaoMs > 0) await dormir(cfg.tutorialAvaliacaoMs);
    await humaniza.enviar(atendimento.from, mensagemAvaliacao(atendimento.from));
  } catch (err) {
    console.warn(`[ponte] tutorial: pedido de avaliação falhou para ${atendimento.from}: ${err.message}`);
  }
}

/** Agenda o envio sem esperar. Devolve a promessa (testes) ou null se não envia. */
function agendar(atendimento) {
  if (!cfg.tutorialVideo || !atendimento?.from) return null;
  // O site já mostra o link do vídeo junto do código, e o pedido de avaliação
  // ("me pede aqui que eu te adiciono") não tem como ser respondido lá.
  if (String(atendimento.from).startsWith('web:')) return null;
  if (atendimento.tutorialEnviado || jaEnviado.has(atendimento.id)) return null;
  atendimento.tutorialEnviado = true;
  jaEnviado.add(atendimento.id);
  return enviar(atendimento).catch((err) => console.warn('[ponte] tutorial:', err.message));
}

module.exports = { agendar, mensagemAvaliacao, MSG_VIDEO, VARIANTES_VIDEO, VARIANTES_AVALIACAO };
