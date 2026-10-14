'use strict';

/**
 * Testa o pedido de código pelo SITE (src/ponte/web.js).
 *
 *   node teste-web.js
 *
 * Sobe o app de verdade e faz o papel dos dois vizinhos: o painel de estoque
 * (chama /web/* com a x-painel-chave) e o braço (pega a tarefa e devolve o que
 * o outro lado respondeu). WhatsApp e IA são dublês; nada sai para a rede.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DATA_TESTE = path.join(os.tmpdir(), 'phaze-teste-web');
fs.rmSync(DATA_TESTE, { recursive: true, force: true });
process.env.PONTE_DATA_DIR = DATA_TESTE;

process.env.DEEPSEEK_API_KEY = '';
for (const k of ['GEMINI_API_KEY', 'GROQ_FALLBACK_API_KEY', 'TRANSCRICAO_API_KEY']) process.env[k] = '';
process.env.NERIX_API_KEY = 'teste';
process.env.EVOLUTION_API_KEY = 'teste';
process.env.PONTE_OPERADOR_NUMERO = '5541999999999';
process.env.PONTE_BRACO_KEY = 'braco-teste';
process.env.PAINEL_BOT_CHAVE = 'painel-teste';
process.env.PONTE_ATIVA = 'true';
process.env.PONTE_MODO = 'autopiloto';
process.env.PONTE_HUMANIZA = 'false';
process.env.PONTE_SELLER_JANELAS = '00:00-23:59';
process.env.PONTE_REPERTORIO = 'false';
process.env.WEB_ESPERA_PEDIDO_MS = '300';

let falhas = 0;
const t = (nome, ok, extra = '') => {
  if (!ok) falhas++;
  console.log(`  ${ok ? 'ok  ' : 'FALHA'} | ${nome}${extra ? ` -> ${extra}` : ''}`);
};
const bloco = (nome) => console.log(`\n--- ${nome} ---`);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const { app } = require('./src/server');
const sender = require('./src/sender');
const chaves = require('./src/chaves');
const ponte = require('./src/ponte');
const fila = require('./src/ponte/fila');
const web = require('./src/ponte/web');
const { dados } = require('./src/ponte/estado');

// O que sai para o operador fica aqui; o que vai para o site segue pelo send
// de verdade, que é justamente a porta que está sendo testada.
const sendReal = sender.send;
const paraOperador = [];
let atrasoOperador = 0;
sender.send = async (numero, texto, opts) => {
  if (String(numero).startsWith('web:')) return sendReal(numero, texto, opts);
  if (atrasoOperador) await dormir(atrasoOperador);
  paraOperador.push(String(texto));
  return true;
};

// Um JPEG de mentira: os três bytes do cabeçalho e enchimento.
const FOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]).toString('base64');

let base = '';
async function chamar(metodo, rota, corpo, chave = 'painel-teste') {
  const r = await fetch(base + rota, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(chave ? { 'x-painel-chave': chave } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
async function braco(metodo, rota, corpo) {
  const r = await fetch(base + '/ponte/braco' + rota, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'x-braco-key': 'braco-teste' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { status: r.status, j: r.status === 204 ? null : await r.json().catch(() => ({})) };
}
const pedir = (login) => chamar('POST', '/web/codigo', { login, nome: 'Site · Zelda', imagemBase64: FOTO, mimetype: 'image/jpeg' });
const ver = (id) => chamar('GET', '/web/codigo/' + id);

/** O braço pega a tarefa da vez, diz que mandou, e entrega a resposta do outro lado. */
async function bracoResponde(texto) {
  const tarefa = await braco('GET', '/proxima');
  const at = fila.ativo();
  if (tarefa.j) await braco('POST', '/resultado', { id: tarefa.j.id, ok: true });
  await braco('POST', '/entrada', { mensagens: [{ texto }], atendimentoId: at && at.id });
  await dormir(150);
  return tarefa.j;
}

const PROIBIDAS = /fornecedor|taobao|\bbot\b|rob[oô]|autom[aá]tic|script|—|#inicio|[一-鿿]/i;

(async () => {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  bloco('a porta');
  t('sem chave é recusado', (await chamar('GET', '/web/estado', null, '')).status === 401);
  t('chave errada é recusada', (await chamar('GET', '/web/estado', null, 'outra-chav')).status === 401);
  const est = await chamar('GET', '/web/estado');
  t('com a chave certa responde ligado', est.status === 200 && est.j.ligado === true, JSON.stringify(est.j));
  t('e diz a janela', est.j.janelaAberta === true && est.j.congelado === false);

  bloco('pedido recusado antes da fila');
  let r = await pedir('meu login e abc123');
  t('login com frase é recusado', r.j.ok === true && r.j.aceito === false && !r.j.id, r.j.mensagem);
  r = await chamar('POST', '/web/codigo', { login: 'abc123', imagemBase64: 'nao-e-foto'.repeat(200) });
  t('foto que não é imagem é recusada', r.j.aceito === false, r.j.mensagem);
  t('nada entrou na fila', !fila.ativo());

  bloco('caminho feliz: código entregue');
  r = await pedir('rrrtsr223');
  const id1 = r.j.id;
  t('pedido aceito com id web:', r.j.aceito === true && /^web:[0-9a-f]{24}$/.test(id1 || ''), id1);
  t('fila vazia: já é a vez dele', r.j.situacao && r.j.situacao.estado === 'ativo', r.j.situacao && r.j.situacao.estado);
  const repetido = await pedir('RRRTSR223');
  t('tocar duas vezes devolve o MESMO pedido', repetido.j.id === id1);
  t('e não cria outro atendimento', dados.atendimentos.filter((a) => String(a.usuario).toLowerCase() === 'rrrtsr223').length === 1);

  const tarefa = await bracoResponde('482913');
  t('o braço recebe login e foto', tarefa && tarefa.usuario === 'rrrtsr223' && Boolean(tarefa.imagem), JSON.stringify(tarefa));
  let s = (await ver(id1)).j;
  t('o site recebe o código', s.estado === 'concluido' && s.codigo === '482913', `${s.estado} ${s.codigo}`);
  t('nada foi para o WhatsApp do cliente', !paraOperador.some((x) => x.includes('482913')));
  t('vez liberada', !fila.ativo());

  bloco('fila com duas pessoas');
  const a = (await pedir('aaaa1111')).j.id;
  const b = (await pedir('bbbb2222')).j.id;
  s = (await ver(b)).j;
  t('o segundo espera com 1 na frente', s.estado === 'aguardando' && s.posicao === 1, `${s.estado} ${s.posicao}`);
  const est2 = await chamar('GET', '/web/estado');
  t('o estado conta 2 na fila', est2.j.naFila === 2, String(est2.j.naFila));

  bloco('o outro lado responde outra coisa');
  await bracoResponde('账号不存在');
  s = (await ver(a)).j;
  t('o primeiro fica com a equipe', s.estado === 'concluido' && !s.codigo, s.estado);
  t('e lê uma mensagem', s.mensagens.length > 0, s.mensagens.map((m) => m.texto.slice(0, 40)).join(' | '));
  t('o operador foi avisado', paraOperador.some((x) => x.includes('Site · Zelda')));
  s = (await ver(b)).j;
  t('o segundo foi promovido', s.estado === 'ativo', s.estado);
  const ap = dados.aprovacoes[dados.aprovacoes.length - 1];
  t('a resposta do operador tem para onde ir', ap && ap.from === a);
  await sender.send(ap.from, 'Essa conta precisa ser conferida. Fala com a gente no WhatsApp.');
  s = (await ver(a)).j;
  t('o #enviar do operador chega no site', s.mensagens[s.mensagens.length - 1].texto.startsWith('Essa conta'));

  bloco('expirou');
  fila.porId(fila.ativo().id).expiraEm = Date.now() - 1000;
  await ponte.tick();
  s = (await ver(b)).j;
  const ultima = s.mensagens[s.mensagens.length - 1]?.texto || '';
  t('o site mostra que expirou', s.estado === 'expirado', s.estado);
  t('e diz para tocar no botão, não para digitar #inicio', ultima.includes('Pedir outro código') && !/#inicio/i.test(ultima), ultima);

  bloco('copiloto e operador lento');
  chaves.definir('aprovacao', true);
  atrasoOperador = 2000;
  const t0 = Date.now();
  r = await pedir('cccc3333');
  t('o painel recebe resposta sem esperar o alerta sair', Date.now() - t0 < 1500 && r.j.aceito === true, `${Date.now() - t0} ms`);
  t('o pedido espera o #ok', dados.tarefas.some((x) => x.usuario === 'cccc3333' && x.estado === 'aguardando_aprovacao'));
  await dormir(2200);
  atrasoOperador = 0;
  chaves.definir('aprovacao', false);

  bloco('desligado');
  chaves.definir('codigos', false);
  t('o estado diz desligado', (await chamar('GET', '/web/estado')).j.ligado === false);
  r = await pedir('dddd4444');
  t('o pedido é recusado com aviso de manutenção', r.j.aceito === false && /manutenção/.test(r.j.mensagem), r.j.mensagem);
  chaves.definir('codigos', null);

  bloco('pedido que não existe');
  s = (await ver('web:' + '0'.repeat(24))).j;
  t('id desconhecido vira expirado com explicação', s.estado === 'expirado' && s.mensagens.length === 1);
  t('id torto é recusado', (await ver('web:xyz')).status === 400);

  bloco('texto que o site mostra');
  const limpo = web.paraSite('Poxa, não deu. Manda *#inicio* e eu te coloco de volta na fila 💚\n\n_Phaze Games_');
  t('#inicio vira o botão e a assinatura sai', limpo === 'Poxa, não deu. Toque em *Pedir outro código* e eu te coloco de volta na fila 💚', limpo);
  const soMandar = web.paraSite('Não perdeu nada: é só mandar *#inicio* aqui que eu te coloco na fila de novo');
  t('"é só mandar #inicio" vira "é só tocar em"', soMandar === 'Não perdeu nada: é só tocar em *Pedir outro código* que eu te coloco na fila de novo', soMandar);
  t('travessão some', !web.paraSite('Pronto — chegou').includes('—'));
  // Última porta: um texto que escapasse com palavra da origem (um #editar
  // descuidado, uma frase nova sem teste) não pode chegar à tela do cliente.
  const idVaz = 'web:' + 'a'.repeat(24);
  await web.guardar(idVaz, 'O fornecedor ainda não respondeu, o robô tenta de novo');
  await web.guardar(idVaz, 'Código: 482913 收到');
  const vaz = (dados.web[idVaz] || { mensagens: [] }).mensagens.map((m) => m.texto);
  t('mensagem com palavra da origem é trocada por texto neutro', vaz.length === 2 && vaz.every((x) => !PROIBIDAS.test(x)) && /equipe/.test(vaz[0]), vaz.join(' | '));
  delete dados.web[idVaz];

  const tudo = Object.values(dados.web || {}).flatMap((x) => x.mensagens.map((m) => m.texto));
  const ruim = tudo.filter((x) => PROIBIDAS.test(x));
  t('nada proibido chegou ao site', ruim.length === 0, ruim.join(' | '));

  server.close();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
