'use strict';

/**
 * Texto de uma mensagem da Evolution, num lugar só.
 *
 * O WhatsApp embrulha a mensagem em envelopes: grupo com mensagens temporárias
 * põe o texto dentro de `ephemeralMessage.message`, "ver uma vez" vem em
 * `viewOnceMessage(V2)`, documento com legenda em `documentWithCaptionMessage`,
 * e mensagem editada em `editedMessage`. Quem lia só `conversation` /
 * `extendedTextMessage` via texto vazio nesses casos e ignorava a mensagem em
 * silêncio — foi assim que um `#grupo` num grupo com mensagens temporárias não
 * produziu nada.
 */

const ENVELOPES = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'deviceSentMessage',
  'editedMessage',
];

/** Abre os envelopes até chegar na mensagem de verdade. */
function desembrulhar(message) {
  let m = message || {};
  for (let i = 0; i < 6; i++) {
    // Edição: o conteúdo novo vem em protocolMessage.editedMessage.
    const edit = m.protocolMessage?.editedMessage;
    if (edit) { m = edit; continue; }
    const env = ENVELOPES.find((k) => m[k]?.message);
    if (!env) break;
    m = m[env].message;
  }
  return m;
}

/** O texto que a pessoa escreveu (ou a legenda, ou a opção tocada no menu). */
function textoDaMensagem(message) {
  const m = desembrulhar(message);
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    // Foto com legenda: o texto do cliente vem no caption, não em conversation.
    m.imageMessage?.caption ||
    // Toque numa opção do MENU EM LISTA. O rowId vem primeiro porque é o número
    // da opção (ver menu.js); o título é reserva para versões sem o id.
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.listResponseMessage?.title ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.templateButtonReplyMessage?.selectedId ||
    ''
  );
}

// Invisíveis que o teclado (iOS principalmente) cola no texto: zero-width,
// marcas de direção, BOM, espaço sem quebra.
const INVISIVEIS = /[​-‏‪-‮⁠-⁤﻿ ᠎]/g;

/** Texto sem invisíveis e sem espaço nas pontas, para comparar comandos. */
function limparComando(texto) {
  return String(texto || '').replace(INVISIVEIS, '').trim();
}

module.exports = { textoDaMensagem, desembrulhar, limparComando };
