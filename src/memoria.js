'use strict';

/**
 * O que o bot LEMBRA de cada cliente.
 *
 * O relato que criou este arquivo: "o cliente manda uma mensagem e a IA
 * responde algo nada a ver". Não era o modelo sendo ruim, era ele respondendo
 * praticamente sem contexto.
 *
 * O histórico guardava 4 turnos e expirava em 6 horas. Quatro turnos somem
 * rápido quando tem consulta de pedido no meio (uma consulta ocupa três
 * mensagens), e depois de seis horas o cliente voltava e o bot começava do
 * zero: não sabia o que ele tinha comprado nem o que estavam resolvendo.
 *
 * São DUAS memórias, com prazos e donos diferentes, e misturar as duas é o que
 * costuma dar errado:
 *
 *   FICHA    o que sabemos sobre a pessoa. Escrita pelo modelo barato de vez em
 *            quando, dura semanas, cabe em três linhas. É o que um atendente
 *            humano tem na cabeça ao reabrir uma conversa.
 *
 *   ASSUNTO  o que estamos resolvendo AGORA. Escrito por CÓDIGO, nunca pelo
 *            modelo, a partir do que as ferramentas devolveram. É fato, não
 *            interpretação, e é o que responde "e o outro?" sem chutar.
 *
 * ONDE ISSO ENTRA NO PROMPT: no turno do CLIENTE, nunca no texto fixo. O texto
 * fixo é cacheado por prefixo, então um dado diferente por pessoa lá dentro faz
 * cada contato ter o seu próprio prefixo e o cache nunca é aproveitado. É o
 * mesmo motivo de o nome do cliente já morar no turno dele.
 */

const store = require('./store');

/** De quantos em quantos turnos do cliente a ficha é reescrita. */
const TURNOS_ATE_RESUMIR = Number(process.env.LLM_FICHA_TURNOS) || 4;

/** Ficha velha demais para valer. Preço mudou, jogo mudou, ele mudou. */
const FICHA_VALIDA_MS = Number(process.env.LLM_FICHA_DIAS || 45) * 24 * 60 * 60 * 1000;

/**
 * O assunto envelhece MUITO mais rápido que a ficha.
 *
 * "Ele está resolvendo o pedido NX-1054" é verdade por algumas horas. Uma
 * semana depois é uma afirmação errada dita com confiança, e o modelo vai
 * responder sobre um pedido que a pessoa já esqueceu.
 */
const ASSUNTO_VALIDO_MS = Number(process.env.LLM_ASSUNTO_HORAS || 48) * 60 * 60 * 1000;

const ler = (from) => store.getContact(from)?.memoria || {};

function gravar(from, patch) {
  store.saveContact(from, { memoria: { ...ler(from), ...patch } });
}

/**
 * O bloco de memória, para colar no turno do cliente. Vazio quando não há nada.
 *
 * As duas regras no fim não são enfeite. A primeira evita o bot abrir a
 * conversa recitando o que sabe da pessoa, que é assustador e não ajuda. A
 * segunda resolve o conflito mais provável: a ficha é de ontem, o cliente está
 * falando agora, e quem sabe da vida dele é ele.
 */
function paraOPrompt(from) {
  const m = ler(from);
  const agora = Date.now();
  const linhas = [];

  if (m.ficha && agora - (m.fichaEm || 0) < FICHA_VALIDA_MS) {
    linhas.push(`O que já sabemos dele: ${m.ficha}`);
  }
  if (m.assunto && agora - (m.assuntoEm || 0) < ASSUNTO_VALIDO_MS) {
    linhas.push(`Em aberto agora: ${m.assunto}`);
  }
  if (!linhas.length) return '';

  return (
    `[MEMÓRIA DO ATENDIMENTO, não é mensagem do cliente]\n${linhas.join('\n')}\n` +
    `Use para não perguntar o que já foi respondido. NUNCA recite isto para ele nem diga que anotou. ` +
    `Se ele disser algo diferente do que está aqui, ELE tem razão e a memória está velha.\n\n`
  );
}

/**
 * Anota o pedido que a ferramenta acabou de devolver. Sem modelo, sem opinião.
 *
 * É a memória que mais evita resposta fora de contexto, e é de graça: a
 * ferramenta já buscou o dado, só estava jogando fora depois de usar uma vez.
 */
function anotarPedido(from, pedido) {
  if (!pedido || !pedido.codigo) return;
  const itens = (pedido.itens || []).map((i) => i.nome).filter(Boolean).slice(0, 2).join(', ');
  const partes = [`pedido ${pedido.codigo}`];
  if (pedido.status) partes.push(pedido.status);
  if (itens) partes.push(itens);
  gravar(from, { assunto: partes.join(' · '), assuntoEm: Date.now() });
}

/** O assunto acabou (compra fechada, problema resolvido, atendente assumiu). */
function limparAssunto(from) {
  gravar(from, { assunto: null, assuntoEm: 0 });
}

/**
 * Está na hora de reescrever a ficha?
 *
 * Contado em turnos e não em tempo: o que faz a ficha envelhecer é a conversa
 * andar, não o relógio. Uma pessoa que mandou quatro mensagens tem quatro
 * mensagens de coisa nova para resumir, tenha isso levado dois minutos ou dois
 * dias.
 */
function precisaResumir(from) {
  const m = ler(from);
  const desde = (m.turnosDesdeFicha || 0) + 1;
  gravar(from, { turnosDesdeFicha: desde });
  return desde >= TURNOS_ATE_RESUMIR;
}

const PROMPT_FICHA =
  'Voce le a conversa de um atendimento de loja de jogos e escreve o que o ' +
  'proximo atendente precisa lembrar deste cliente.\n\n' +
  'Maximo 3 linhas, em portugues, direto, sem saudacao e sem opiniao.\n' +
  'So fatos que APARECERAM na conversa: o que ele comprou, qual console tem, ' +
  'qual problema teve, o que ja foi resolvido, o que ficou pendente.\n' +
  'NAO invente nada. NAO escreva o que ele perguntou, escreva o que ficou sabido.\n' +
  'Se nao houver nada que valha lembrar, responda exatamente: (nada)';

/**
 * Reescreve a ficha com o modelo barato.
 *
 * `barato: true` porque ninguém está esperando isto na tela: é chamada solta,
 * depois de a resposta do cliente já ter saído.
 *
 * FALHA CALADA de propósito. Se o resumo não sair, o atendimento continua
 * exatamente como era antes deste arquivo existir. Uma memória que às vezes não
 * atualiza é muito melhor que um atendimento que quebra quando o resumo falha.
 */
async function atualizarFicha(from, mensagens) {
  const conversa = (mensagens || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'Cliente' : 'Loja'}: ${String(m.content || '').slice(0, 400)}`)
    .join('\n')
    .slice(-4000);

  if (conversa.length < 80) return; // conversa curta demais para ter o que lembrar

  const anterior = ler(from).ficha;
  const entrada =
    (anterior ? `Ficha atual (atualize, nao repita o que mudou):\n${anterior}\n\n` : '') +
    `Conversa:\n${conversa}`;

  const msg = await require('./ai').chat(
    [{ role: 'system', content: PROMPT_FICHA }, { role: 'user', content: entrada }],
    { maxTokens: 300, barato: true },
  );

  const texto = String(msg?.content || '').trim();
  if (!texto || /^\(?nada\)?$/i.test(texto)) {
    gravar(from, { turnosDesdeFicha: 0 });
    return;
  }

  gravar(from, { ficha: texto.slice(0, 600), fichaEm: Date.now(), turnosDesdeFicha: 0 });
  console.log(`[memoria] ficha de ${from} atualizada (${texto.length} caracteres)`);
}

/** Apaga tudo o que sabemos de um contato (usado pelo #esquecer). */
function esquecer(from) {
  store.saveContact(from, { memoria: null });
}

module.exports = {
  paraOPrompt,
  anotarPedido,
  limparAssunto,
  precisaResumir,
  atualizarFicha,
  esquecer,
  ler,
};
