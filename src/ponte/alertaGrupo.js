'use strict';

/**
 * Alerta de "braço parado" no grupo da equipe.
 *
 * O operador no privado já era avisado (index.js: alertar). O que faltava é a
 * equipe saber: captcha às 3 da manhã chegava a UM celular, e o resto da loja
 * não tinha como destravar. Aqui o mesmo incidente vai para o grupo "STAFF" —
 * o mesmo destino do aviso de venda (vendas.grupoDeVendas).
 *
 * Só o GRUPO, de propósito: sem grupo configurado não faz nada, em vez de cair
 * no privado como o avisarVenda faz. O operador já recebeu o alerta dele, e
 * mandar de novo para o mesmo número seria mensagem em dobro.
 *
 * ATENÇÃO ao vocabulário: o grupo sai pelo MESMO número comercial, então vale o
 * filtro de politica.limparAlerta ("braço", "bot", "automático" etc. viram "sistema").
 *
 * Dois incidentes, cada um com UM alerta e UM "voltou":
 *   - bloqueio: captcha / login perdido (/bloqueio do braço, ou congelamento
 *     automático que virou manual). Volta no #liberar.
 *   - mudo: nenhum contato do braço há PONTE_BRACO_MUDO_MIN min, com cliente
 *     esperando. Volta quando ele fala de novo.
 * O estado vive em dados.alertaGrupo (sobrevive a deploy): reiniciar o bot no
 * meio do incidente não repete o alerta nem perde o "voltou".
 *
 * Desliga com PONTE_ALERTA_GRUPO=false.
 */

const cfg = require('./config');
const fila = require('./fila');
const limites = require('./limites');
const politica = require('./politica');
const { dados, persistAgora } = require('./estado');
const sender = require('../sender');

const TRABALHANDO_MAX_MS = 5 * 60 * 1000; // igual ao EXECUTANDO_MAX_MS do index.js

function estado() {
  if (!dados.alertaGrupo) dados.alertaGrupo = {};
  return dados.alertaGrupo;
}

/** Quantos clientes aguardam código (na fila + parados na entrada). */
function clientesEsperando() {
  const s = fila.situacao();
  return (s.ativo ? 1 : 0) + s.aguardando.length + require('./recepcao').esperandoVez().length;
}

/** Manda ao grupo. true = saiu; false = sem grupo, desligado ou falhou. */
async function enviar(texto) {
  if (!cfg.alertaGrupo) return false;
  let grupo = null;
  try {
    grupo = await require('../vendas').grupoDeVendas();
  } catch (err) {
    console.warn('[ponte/alertaGrupo] não consegui resolver o grupo:', err.message);
  }
  if (!grupo) return false;
  const { texto: limpo } = politica.limparAlerta(texto);
  try {
    await sender.send(grupo, limpo, { typing: false });
    return true;
  } catch (err) {
    console.error(`[ponte/alertaGrupo] falha ao avisar o grupo ${grupo}:`, err.message);
    return false;
  }
}

const esperando = (n) => `${n} ${n === 1 ? 'cliente esperando' : 'clientes esperando'}`;

/** Captcha / login perdido. Chamado por bloqueioDetectado (já deduplicado lá). */
async function bloqueio(motivo) {
  const e = estado();
  if (e.bloqueio) return; // um alerta por incidente
  const ok = await enviar(
    `🛑 *Envio de código travado: precisa de uma pessoa*\n\n${motivo}\n\n` +
      `${esperando(clientesEsperando())} código, e nada sai até resolver.\n\n` +
      `O que fazer: abrir a tela remota, resolver o captcha / login e responder *#liberar*.`,
  );
  if (!ok) return;
  e.bloqueio = { em: Date.now() };
  persistAgora();
}

/** Chamado a cada minuto pelo tick: vê se algo mudou e avisa só na mudança. */
async function vigiar() {
  try {
    const e = estado();

    // Bloqueio resolvido: o disjuntor fechou (#liberar).
    if (e.bloqueio && limites.disjuntor().estado !== 'aberto') {
      const n = clientesEsperando();
      delete e.bloqueio;
      persistAgora();
      await enviar(
        '✅ *Envio liberado.* Os envios voltaram' +
          (n ? `, ${n} ${n === 1 ? 'cliente segue' : 'clientes seguem'} na fila.` : '.'),
      );
    }

    // Mudo: sem contato do braço.
    const visto = dados.coletaVistaEm || 0;
    if (!visto) return; // nunca conectou não é o mesmo que sumiu
    const idade = Date.now() - visto;
    const limite = cfg.bracoMudoMin * 60 * 1000;

    if (e.mudo) {
      if (visto > e.mudo.visto && idade < limite) {
        delete e.mudo;
        persistAgora();
        await enviar('✅ *Sistema de código de volta.* Voltou a responder, os envios seguem.');
      }
      return;
    }

    if (idade <= limite) return;
    const n = clientesEsperando();
    if (!n) return; // sem cliente esperando, é deploy ou madrugada: não incomoda
    // Com a mão na massa não é silêncio, é trabalho (mesma regra do vigiarColeta).
    const trabalhando = dados.tarefas.some(
      (t) => t.estado === 'executando' && Date.now() - (t.pegaEm || 0) < TRABALHANDO_MAX_MS,
    );
    if (trabalhando) return;

    const ok = await enviar(
      `🔌 *Sistema de código sem resposta há ${Math.round(idade / 60000)} min*\n\n` +
        `${esperando(n)} código e nada sai.\n\n` +
        `O que fazer: ver se o serviço de código está no ar (painel / tela remota) e reiniciar se precisar.`,
    );
    if (!ok) return;
    e.mudo = { em: Date.now(), visto };
    persistAgora();
  } catch (err) {
    console.error('[ponte/alertaGrupo] erro:', err.message);
  }
}

module.exports = { bloqueio, vigiar, clientesEsperando, enviar };
