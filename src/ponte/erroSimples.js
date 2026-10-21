'use strict';

/**
 * Erro SIMPLES do outro lado, que o próprio cliente resolve.
 *
 * Às vezes a resposta não é o código: é "a foto está errada" ou "esse login não
 * existe". Antes, tudo isso virava um alerta para o operador traduzir e
 * repassar na mão. Aqui a IA só CLASSIFICA a mensagem num conjunto fechado; o
 * texto que o cliente lê é FIXO, escolhido pelo código — a IA nunca escreve
 * para o cliente.
 *
 *   foto_errada  — print errado / ilegível / tela que não é a pedida
 *   login_errado — login inexistente, com erro de digitação, ou de outra loja
 *   outro        — todo o resto: comportamento de sempre (alerta ao operador)
 *
 * FALHA SEGURA: erro, timeout, JSON torto, categoria desconhecida ou confiança
 * baixa viram `outro`. Na dúvida quem decide é gente.
 *
 * FREIO: o mesmo erro, no mesmo cliente, só é explicado `MAX_AVISOS` vezes. Na
 * vez seguinte escala para o operador em vez de pedir a terceira vez — quem
 * errou duas não acerta na terceira, e o laço cansa o cliente.
 *
 * Texto ao cliente: voz de sistema automático, sem "vou ver"/"estou
 * verificando" de pessoa, e NUNCA a origem do código nem quem o gera.
 */

const cfg = require('./config');
const { dados, persistAgora } = require('./estado');

const CATEGORIAS = ['foto_errada', 'login_errado'];
const MAX_AVISOS = 2;
const VALIDADE_MS = 2 * 60 * 60 * 1000;
const PRAZO_IA_MS = 20_000;

const carregarAi = () => require('../ai');

const VARIANTES = {
  foto_errada: [
    'A foto que chegou não é a tela certa. 📸\n\n' +
      'Manda de novo o *print da tela de verificação* do console pedindo o código, inteiro e bem nítido. 🙏\n\n' +
      'Assim que ela chegar, o pedido continua sozinho. ✅',
    'Não consegui validar essa foto. 😕\n\n' +
      'Preciso do *print da tela de verificação* do console, mostrando a tela inteira e legível. 📲\n\n' +
      'É só mandar aqui que o pedido segue. 👍',
    'Essa imagem não serviu para o pedido. 🧐\n\n' +
      'Manda outra: o *print da tela do console pedindo o código*, sem cortar nada e sem tremido. 📸\n\n' +
      'Chegando a foto certa, o pedido segue automaticamente. ✅',
  ],
  login_errado: [
    'O login enviado não foi aceito. 😕\n\n' +
      'Confere na mensagem de entrega e manda *aqui no WhatsApp* só o *primeiro* login, *sem a senha*. 🔑\n\n' +
      'Assim que chegar, o pedido continua sozinho. ✅',
    'Esse login não deu certo. 🧐\n\n' +
      'Olha de novo a mensagem de entrega (do lado da 🔑 ou de *Login:*) e manda só o login, sem a senha. 🙏\n\n' +
      'Recebendo o certo, o pedido segue. 👍',
    'Esse login não foi encontrado no sistema. 🔎\n\n' +
      'Pode ter um erro de digitação: copia o *primeiro* login da mensagem de entrega e cola aqui, *sem a senha*. 🔑\n\n' +
      'Com ele certo, o pedido continua. ✅',
  ],
};

function extrairJson(bruto) {
  const t = String(bruto || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const i = t.indexOf('{');
  const f = t.lastIndexOf('}');
  if (i === -1 || f <= i) return null;
  try {
    return JSON.parse(t.slice(i, f + 1));
  } catch {
    return null;
  }
}

const SISTEMA =
  'Você classifica a mensagem de uma loja chinesa que respondeu a um pedido de código de ' +
  'verificação de conta Nintendo. Nós enviamos um PRINT da tela do console e o LOGIN da conta.\n' +
  'Escolha UMA categoria:\n' +
  '- foto_errada: a loja diz que o print/foto está errado, borrado, cortado, não é a tela certa, ou pede outro print.\n' +
  '- login_errado: a loja diz que a conta/login não existe, está errado, tem erro de digitação, ' +
  'não é conta dela ou não encontra o usuário.\n' +
  '- outro: QUALQUER outra coisa (preço, estoque, pede para aguardar, pergunta algo, pagamento, ' +
  'conversa solta, ou se você não tem certeza).\n' +
  'Responda SOMENTE o JSON {"categoria":"foto_errada|login_errado|outro","confianca":"alta|media|baixa"}.';

/**
 * @returns {Promise<{categoria:'foto_errada'|'login_errado'|'outro', confianca:string}>}
 * Nunca lança.
 */
async function classificar(texto) {
  const seguro = { categoria: 'outro', confianca: 'baixa' };
  try {
    const msg = await Promise.race([
      carregarAi().chat(
        [
          { role: 'system', content: SISTEMA },
          { role: 'user', content: String(texto || '').slice(0, 500) },
        ],
        { temperature: 0, maxTokens: 60, barato: true },
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error('prazo da IA')), PRAZO_IA_MS).unref()),
    ]);
    const j = extrairJson(msg?.content);
    if (!j) return seguro;
    const categoria = CATEGORIAS.includes(j.categoria) ? j.categoria : 'outro';
    const confianca = ['alta', 'media', 'baixa'].includes(j.confianca) ? j.confianca : 'baixa';
    // Confiança baixa não age: é o mesmo que "outro".
    if (categoria === 'outro' || confianca === 'baixa') return { categoria: 'outro', confianca };
    return { categoria, confianca };
  } catch (err) {
    console.warn('[ponte/erroSimples] IA falhou, tratando como "outro":', err.message);
    return seguro;
  }
}

function contador(from) {
  if (!dados.errosSimples) dados.errosSimples = {};
  const e = dados.errosSimples;
  if (e[from] && Date.now() - e[from].em > VALIDADE_MS) delete e[from];
  return e;
}

/** Código entregue: zera a contagem do cliente. */
function limpar(from) {
  if (dados.errosSimples?.[from]) {
    delete dados.errosSimples[from];
    persistAgora();
  }
}

/**
 * Tenta resolver a mensagem sem gente. Devolve true se tratou (o chamador
 * PARA); false = segue o caminho normal (alerta ao operador).
 *
 * `deps` (injetadas por ponte/index.js para evitar ciclo de require):
 *   escolher(chave, lista, from), enviar(from, texto), concluir(id, motivo),
 *   promover(), avisar(texto), reabrir(from, estado), imagemDoPedido(at)
 */
async function tratar(at, textoZh, deps) {
  if (!cfg.erroSimples) return false;
  // Cliente do site não tem passo no WhatsApp para reabrir.
  if (String(at.from).startsWith('web:')) return false;

  const { categoria } = await classificar(textoZh);
  if (!CATEGORIAS.includes(categoria)) return false;

  const mapa = contador(at.from);
  const reg = mapa[at.from] || { em: Date.now() };
  const jaAvisou = reg[categoria] || 0;
  if (jaAvisou >= MAX_AVISOS) {
    console.log(`[ponte/erroSimples] ${at.from}: ${categoria} pela ${jaAvisou + 1}a vez — escalando`);
    return false;
  }

  // Em qual passo o cliente volta. login_errado precisa da foto original para
  // o login novo fechar o par; se ela sumiu, quem resolve é gente.
  let estado;
  if (categoria === 'foto_errada') {
    estado = { usuario: at.usuario || null, imagem: null, etapa: 'foto' };
  } else {
    const imagem = deps.imagemDoPedido(at);
    if (!imagem) return false;
    estado = { usuario: null, imagem, etapa: 'usuario' };
  }

  reg[categoria] = jaAvisou + 1;
  reg.em = Date.now();
  mapa[at.from] = reg;
  persistAgora();

  const texto = deps.escolher(`erro_${categoria}`, VARIANTES[categoria], at.from);

  // Devolve o cliente ao passo ANTES de falar: a resposta dele pode chegar
  // antes de esta função terminar.
  deps.reabrir(at.from, estado);
  await deps.concluir(at.id, 'erro_simples');
  await deps.enviar(at.from, texto);

  const quem = `*${at.nome}* · \`${at.usuario}\``;
  await deps.avisar(
    categoria === 'foto_errada'
      ? `📸 Pedido de ${quem}: a foto não serviu. Já pedi outra ao cliente (${reg[categoria]}/${MAX_AVISOS}).`
      : `🔑 Pedido de ${quem}: o login não foi aceito. Já pedi o login de novo (${reg[categoria]}/${MAX_AVISOS}).`,
  );

  await deps.promover();
  return true;
}

module.exports = { classificar, tratar, limpar, VARIANTES, MAX_AVISOS };
