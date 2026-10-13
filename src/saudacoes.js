'use strict';

/**
 * Textos do bom dia e da boa noite do grupo.
 *
 * Lista fixa, escrita à mão: o dono pediu variedade com cara de Phaze Games, e
 * isso o modelo não acertava sozinho (saía poesia genérica). A variedade vem do
 * sorteio: nunca repete nenhuma das últimas JANELA usadas.
 *
 * Regras que valem para todo texto daqui:
 *  - nada de preço, link nem promessa. "Cupom" e "novidade" só aparecem como
 *    convite para olhar o grupo, nunca como garantia de que existe um;
 *  - nada de religião, política nem time;
 *  - a hora de abrir não vai escrita aqui: o rodapé da boa noite (community.js)
 *    já diz a hora certa, vinda da config.
 */

/** Quantas das últimas saudações ficam de fora do sorteio. */
const JANELA = 5;

const DIA = [
  'Bom dia, galera!\n\nGrupo aberto, café na mão e Switch carregado. Bora jogar!',
  'Bom dia, pessoal!\n\nQue o dia comece com save novo e termine com conquista desbloqueada.',
  'Acordou, jogador?\n\nBom dia! O grupo abriu, fiquem à vontade.',
  'Bom dia!\n\nNovo dia, nova fase. Qual jogo vai rodar hoje por aí? 🌞',
  'Bom dia, Phaze Games!\n\nQue hoje não tenha lag, nem fila de servidor, nem boss impossível.',
  'Bom dia, família gamer!\n\nO grupo está aberto. Passem aqui para ver as novidades do dia.',
  'Bom dia!\n\nPulou da cama? Então já ganhou a primeira moeda do dia.',
  'Bom dia, galera!\n\nDá uma olhada no grupo ao longo do dia, às vezes tem cupom e novidade por aqui. 🎁',
  'Bom dia!\n\nQue seu dia tenha checkpoint perto e vida extra de sobra.',
  'Bom dia, pessoal!\n\nBateria cheia no controle, ânimo cheio no peito. Bora!',
  'Bom dia!\n\nPrimeiro nível do dia carregando... pronto, pode jogar. Grupo aberto!',
  'Bom dia, jogadores!\n\nQuem já está de olho no próximo jogo da wishlist? 🔥',
  'Bom dia!\n\nRespira, toma uma água e só depois abre o jogo. A gente espera.',
  'Bom dia, gamers!\n\nQue a sorte do loot esteja com vocês hoje.',
  'Bom dia, galera da Phaze!\n\nO grupo abriu. Novidades, cupons e papo de jogo ficam por aqui.',
  'Bom dia!\n\nFone no ouvido, trilha sonora de RPG e dia leve pela frente. 🎧',
  'Bom dia, pessoal!\n\nQue hoje a gente zere pelo menos uma pendência e um jogo do backlog.',
  'Bom dia!\n\nCafé da manhã de campeão e uma partida de aquecimento. Grupo aberto!',
  'Bom dia, time!\n\nQualquer dúvida sobre jogos, é só chamar. Bom jogo e bom dia pra todos!',
  'Bom dia!\n\nNovo dia, nova rodada. Que venham partidas boas e gente legal. 🚀',
  'Bom dia, galera!\n\nQuem jogou até tarde ontem levanta o controle! Hoje o dia é longo, vai com calma.',
  'Bom dia!\n\nQue o seu dia tenha menos tela de loading e mais fase boa.',
];

const NOITE = [
  'Boa noite, galera!\n\nO grupo fecha agora e abre de manhã. Salvem o jogo e descansem!',
  'Boa noite, pessoal!\n\nHora de dar pause. O grupo descansa e volta amanhã cedo. 🎮',
  'Boa noite!\n\nSalva o progresso, desliga o console e vai dormir. Amanhã tem mais!',
  'Boa noite, Phaze Games!\n\nO grupo fecha por hoje. Obrigado por mais um dia por aqui.',
  'Boa noite, família gamer!\n\nDescansem bem, que amanhã o grupo abre cedo.',
  'Boa noite!\n\nÚltima partida? Então que seja a da vitória. O grupo fecha agora. 🌙',
  'Boa noite, galera!\n\nFim de fase por hoje. Quem dorme cedo acorda com a barra de energia cheia.',
  'Boa noite!\n\nSwitch no dock, carregando junto com você. Até amanhã de manhã!',
  'Boa noite, pessoal!\n\nO grupo fecha agora. Amanhã tem novidade e conversa nova por aqui.',
  'Boa noite!\n\nQue os sonhos tenham trilha sonora boa e nenhum game over. 🌠',
  'Boa noite, gamers!\n\nTira o fone, apaga a luz e recarrega a vida. Até amanhã!',
  'Boa noite!\n\nO grupo vai dormir e volta de manhã. Se rolou cupom hoje, dá uma olhada nas mensagens de cima.',
  'Boa noite, time!\n\nHoje foi dia de jogo e de papo bom. Descansem, merecem.',
  'Boa noite, galera!\n\nSalvando o jogo e fechando o grupo por hoje. Até logo! 🎮',
  'Boa noite!\n\nQuem for virar a noite no jogo, bom jogo. Quem for dormir, bons sonhos. O grupo descansa agora.',
  'Boa noite, pessoal da Phaze!\n\nAgradecemos a companhia hoje. O grupo reabre de manhã.',
  'Boa noite!\n\nHora de recarregar o controle e você também. Amanhã a gente joga de novo.',
  'Boa noite, jogadores!\n\nQue o backlog espere e o sono vença hoje. Grupo fechado até de manhã. 🌙',
  'Boa noite!\n\nFim de mais um dia de fase boa. Descansa que amanhã tem continue.',
  'Boa noite, galera!\n\nObrigado por estarem aqui. Durmam bem, o grupo volta de manhã.',
  'Boa noite!\n\nCoruja gamer também precisa dormir. Até a próxima fase, amanhã!',
  'Boa noite, pessoal!\n\nFechamos o grupo por hoje. De manhã tem novidade e cupom pra ficar de olho, quando rolar. 🎁',
];

/**
 * Sorteia um texto que não esteja entre os últimos usados.
 *
 * @param {'dia'|'noite'} tipo
 * @param {number[]} recentes  índices usados por último (o mais novo no fim)
 * @param {() => number} [rand] injetável para teste
 * @returns {{texto:string, indice:number}}
 */
function sortear(tipo, recentes = [], rand = Math.random) {
  const lista = tipo === 'noite' ? NOITE : DIA;
  const fora = new Set(recentes.slice(-JANELA));
  const livres = lista.map((_, i) => i).filter((i) => !fora.has(i));
  const pool = livres.length ? livres : lista.map((_, i) => i);
  const indice = pool[Math.floor(rand() * pool.length)];
  return { texto: lista[indice], indice };
}

module.exports = { DIA, NOITE, JANELA, sortear };
