'use strict';

/**
 * RESUMO DO DIA — uma mensagem por noite para o grupo da equipe.
 *
 * De onde vem cada número:
 *  - VENDAS: vendas.json (o carimbo `notificado` que o webhook da Nerix grava
 *    uma vez por pedido pago, e o `valor` guardado junto). Conta pelo dia do
 *    PAGAMENTO em Brasília. Pedido pago antes desta versão não tem valor: entra
 *    na contagem, não na soma, e o resumo avisa.
 *  - MEMBROS NOVOS: diferença entre o número de participantes do grupo oficial
 *    agora e o do último retrato guardado (resumo.json). Não usa o webhook de
 *    entrada/saída do grupo porque a Evolution não está configurada para
 *    entregá-lo aqui. É o SALDO (entradas menos saídas), não só as entradas.
 *  - CÓDIGOS ENTREGUES: casos-ponte.jsonl, eventos 'encerrado' com motivo
 *    'codigo_entregue' no dia. Só leitura.
 *
 * Sai uma vez por dia, perto de RESUMO_HORA (BRT, padrão 23). O minuto exato
 * muda todo dia: hora-base + desvio de até RESUMO_JITTER_MIN (padrão 30) minutos,
 * gravado em resumo.json e diferente do de ontem em pelo menos 15 min. O dia
 * enviado fica gravado: restart no meio da noite não duplica nem re-sorteia.
 */

const fs = require('fs');
const path = require('path');

const jitter = require('./jitter');

const DATA_DIR = process.env.PONTE_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'resumo.json');

/** @type {{ultimoEnvio?:string, retrato?:{n:number, em:number}}} */
let estado = {};
function carregar() {
  try { estado = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { estado = {}; }
}
function salvar() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(estado), 'utf8');
  } catch (err) { console.error('[resumo] não consegui gravar o estado:', err.message); }
}
carregar();

const ligado = () => process.env.RESUMO_LIGADO !== 'false';
const horaEnvio = () => {
  const h = Number(process.env.RESUMO_HORA ?? 23);
  return Number.isFinite(h) ? h : 23;
};

/** Dia (AAAA-MM-DD) e hora em Brasília de um instante. */
function brt(ms) {
  const d = new Date(ms - 3 * 3600 * 1000);
  return { dia: d.toISOString().slice(0, 10), hora: d.getUTCHours(), minuto: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** Minuto do dia (BRT) em que o resumo deste dia sai: base + desvio gravado. */
function horarioDoDia(dia) {
  estado.jitter = estado.jitter || {};
  const jaTinha = Number.isFinite(estado.jitter[dia]);
  const faixa = Number(process.env.RESUMO_JITTER_MIN ?? jitter.FAIXA);
  const desvio = jitter.desvioDoDia(estado.jitter, dia, { faixa });
  if (!jaTinha) salvar();
  // Nunca vira o dia: o resumo é "do dia" e a trava de envio é por data.
  return Math.max(0, Math.min(1439, horaEnvio() * 60 + desvio));
}

const TITULOS = ['Resumo do dia', 'Resumo do dia da equipe', 'Resumo do dia, equipe'];
const DESPEDIDAS = ['Bom descanso, equipe!', 'Bom descanso, time!', 'Fim de expediente. Bom descanso, equipe!'];

/** Variação que não repete a última (índice gravado no estado). */
function variar(chave, lista) {
  estado.textoUlt = estado.textoUlt || {};
  const { texto, indice } = jitter.variar(lista, estado.textoUlt[chave]);
  estado.textoUlt[chave] = indice;
  salvar();
  return texto;
}

const moeda = require('./moeda');

function vendasDoDia(dia) {
  const pedidos = require('./vendas')._dados().pedidos || {};
  let qtd = 0;
  // Um total POR MOEDA: real e peso mexicano nunca se somam.
  const totais = {};
  let semValor = 0;
  for (const reg of Object.values(pedidos)) {
    if (!reg.notificado || brt(reg.notificado).dia !== dia) continue;
    qtd++;
    if (Number.isFinite(reg.valor)) moeda.somar(totais, reg.valor, reg.moeda);
    else semValor++;
  }
  return { qtd, totais, semValor };
}

function codigosDoDia(dia) {
  try {
    return require('./ponte/registro')
      .ultimos(5000)
      .filter((l) => l.tipo === 'encerrado' && l.motivo === 'codigo_entregue' && brt(new Date(l.em).getTime()).dia === dia)
      .length;
  } catch { return null; }
}

/** Participantes agora, ou null. */
async function membrosAgora() {
  const comunidade = require('./config').community;
  const grupo = require('./grupoOficial').jid();
  if (!grupo) return null;
  try {
    return await require('./evolution').contarParticipantes(
      grupo,
      comunidade.instance ? { instance: comunidade.instance } : {},
    );
  } catch (err) {
    console.warn('[resumo] não consegui contar o grupo:', err.message);
    return null;
  }
}

/** Monta o texto. `agora` e `membros` injetáveis para teste. */
async function montar({ agora = Date.now(), parcial = false } = {}) {
  const { dia } = brt(agora);
  const v = vendasDoDia(dia);
  const codigos = codigosDoDia(dia);
  const n = await membrosAgora();

  const [, mes, d] = dia.split('-');
  const linhas = [
    `*${parcial ? 'Resumo parcial' : variar('titulo', TITULOS)}* —${d}/${mes}`,
    '',
    `💰 Vendas: *${v.qtd}* (${moeda.formatarTotais(v.totais)})`,
  ];
  if (v.semValor) linhas.push(`_${v.semValor} pedido(s) sem valor registrado, fora da soma._`);

  const base = estado.retrato;
  if (n == null) linhas.push('👥 Membros novos no grupo: *sem dados*');
  else if (!base) linhas.push(`👥 Membros no grupo: *${n}* _(a contagem de novos começa amanhã)_`);
  else {
    const dif = n - base.n;
    const desde = agora - base.em > 36 * 3600 * 1000 ? ` _(desde ${brt(base.em).dia.split('-').reverse().slice(0, 2).join('/')})_` : '';
    linhas.push(`👥 Membros novos no grupo: *${dif >= 0 ? '+' : ''}${dif}*${desde}`);
  }

  if (codigos != null) linhas.push(`🔑 Códigos entregues: *${codigos}*`);

  // Cobranças da XPag geradas e ainda não pagas (os lembretes ao cliente só
  // saem quando há telefone; as sem telefone ficam para a equipe ver aqui).
  try {
    const pend = require('./xpagLembretes').pendentes(agora);
    if (pend.total) linhas.push(`⏳ Pendentes XPag: *${pend.total}*${pend.semTelefone ? ` (${pend.semTelefone} sem telefone)` : ''}`);
  } catch { /* sem lembretes, sem linha */ }

  if (!parcial) linhas.push('', variar('despedida', DESPEDIDAS));
  return { texto: linhas.join('\n'), membros: n };
}

/** Resumo parcial, para o #resumo. Não grava nada. */
async function parcial() {
  return (await montar({ parcial: true })).texto;
}

/**
 * Uma volta do agendador: envia se for a hora e ainda não foi hoje.
 * Devolve true quando enviou.
 */
async function tick(agora = Date.now()) {
  if (!ligado()) return false;
  const { dia, minuto } = brt(agora);
  const quando = horarioDoDia(dia);

  // Primeiro retrato, para a primeira noite já ter com o que comparar.
  if (!estado.retrato && minuto < quando) {
    const n = await membrosAgora();
    if (n != null) { estado.retrato = { n, em: agora }; salvar(); }
  }

  if (minuto < quando || estado.ultimoEnvio === dia) return false;

  // Marca ANTES de enviar: melhor perder um resumo que mandar dois.
  estado.ultimoEnvio = dia;
  salvar();

  const { texto, membros } = await montar({ agora });
  try {
    await require('./vendas').avisarVenda(texto);
  } catch (err) {
    console.error('[resumo] falha ao enviar:', err.message);
    return false;
  }
  if (membros != null) { estado.retrato = { n: membros, em: agora }; salvar(); }
  console.log(`[resumo] resumo de ${dia} enviado`);
  return true;
}

let timer = null;
function iniciar({ intervaloMs = 5 * 60 * 1000 } = {}) {
  if (timer || !ligado()) return;
  timer = setInterval(() => tick().catch((err) => console.error('[resumo]', err.message)), intervaloMs);
  timer.unref();
  console.log(`[resumo] resumo diário ligado (${horaEnvio()}h BRT, ±${process.env.RESUMO_JITTER_MIN ?? jitter.FAIXA} min)`);
}
function parar() { if (timer) clearInterval(timer); timer = null; }

/** O grupo mudou (#grupo): o retrato de membros era do antigo, a diferença não faria sentido. */
function grupoMudou() { delete estado.retrato; salvar(); }

module.exports = { grupoMudou, iniciar, parar, tick, parcial, montar, horarioDoDia, DESPEDIDAS, TITULOS, _estado: () => estado, _recarregar: carregar };
