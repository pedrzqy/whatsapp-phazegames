'use strict';
// Escolha da conversa por título (lógica pura). node teste-lista.js
const { escolherConversa, normalizar } = require('./src/lista');
let falhas = 0;
const t = (n, c) => { console.log((c ? '  ok  ' : 'FALHA') + ' | ' + n); if (!c) falhas++; };
const L = [
  { texto: '百汇游戏店\n好的', visivel: true },
  { texto: '山王电玩\n你好', visivel: true },
];
t('acha pelo título, não pela posição', escolherConversa(L, '山王电玩') === 1);
t('acha a outra loja', escolherConversa(L, '百汇游戏店') === 0);
t('título ausente = -1', escolherConversa(L, '没有') === -1);
t('título vazio nunca casa', escolherConversa(L, '') === -1);
t('prefere visível', escolherConversa([{ texto: '山王电玩', visivel: false }, { texto: '山王电玩 2', visivel: true }], '山王电玩') === 1);
t('usa o oculto se for o único', escolherConversa([{ texto: '山王电玩', visivel: false }], '山王电玩') === 0);
t('ignora espaços e invisíveis', normalizar(' 山王​ 电玩 ') === '山王电玩');
t('lista vazia', escolherConversa([], 'x') === -1);
console.log(falhas ? `\n${falhas} falha(s)` : '\ntodos passaram');
process.exit(falhas ? 1 : 0);
