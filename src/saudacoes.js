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
  'Bom dia, galera! ☀️ Grupo aberto, café na mão e Switch carregado. Bora jogar!',
  'Bom dia, pessoal! 🎮 Que o dia comece com save novo e termine com conquista desbloqueada.',
  'Acordou, jogador? ☕ Bom dia! O grupo abriu, fiquem à vontade.',
  'Bom dia! 🌞 Novo dia, nova fase. Qual jogo vai rodar hoje por aí?',
  'Bom dia, Phaze Games! 🕹️ Que hoje não tenha lag, nem fila de servidor, nem boss impossível.',
  'Bom dia, família gamer! 💚 O grupo está aberto. Passem aqui para ver as novidades do dia.',
  'Bom dia! 🍄 Pulou da cama? Então já ganhou a primeira moeda do dia.',
  'Bom dia, galera! 🎁 Dá uma olhada no grupo ao longo do dia, às vezes tem cupom e novidade por aqui.',
  'Bom dia! ⭐ Que seu dia tenha checkpoint perto e vida extra de sobra.',
  'Bom dia, pessoal! 🎮 Bateria cheia no controle, ânimo cheio no peito. Bora!',
  'Bom dia! 🌅 Primeiro nível do dia carregando... pronto, pode jogar. Grupo aberto!',
  'Bom dia, jogadores! 🔥 Quem já está de olho no próximo jogo da wishlist?',
  'Bom dia! ☀️ Respira, toma uma água e só depois abre o jogo. A gente espera.',
  'Bom dia, gamers! 🗡️ Que a sorte do loot esteja com vocês hoje.',
  'Bom dia, galera da Phaze! 🕹️ O grupo abriu. Novidades, cupons e papo de jogo ficam por aqui.',
  'Bom dia! 🎧 Fone no ouvido, trilha sonora de RPG e dia leve pela frente.',
  'Bom dia, pessoal! 🌈 Que hoje a gente zere pelo menos uma pendência e um jogo do backlog.',
  'Bom dia! 🍳 Café da manhã de campeão e uma partida de aquecimento. Grupo aberto!',
  'Bom dia, time! 💚 Qualquer dúvida sobre jogos, é só chamar. Bom jogo e bom dia pra todos!',
  'Bom dia! 🚀 Novo dia, nova rodada. Que venham partidas boas e gente legal.',
  'Bom dia, galera! 🎮 Quem jogou até tarde ontem levanta o controle! Hoje o dia é longo, vai com calma.',
  'Bom dia! ✨ Que o seu dia tenha menos tela de loading e mais fase boa.',
];

const NOITE = [
  'Boa noite, galera! 🌙 O grupo fecha agora e abre de manhã. Salvem o jogo e descansem!',
  'Boa noite, pessoal! 🎮 Hora de dar pause. O grupo descansa e volta amanhã cedo.',
  'Boa noite! 😴 Salva o progresso, desliga o console e vai dormir. Amanhã tem mais!',
  'Boa noite, Phaze Games! 🌌 O grupo fecha por hoje. Obrigado por mais um dia por aqui.',
  'Boa noite, família gamer! 💚 Descansem bem, que amanhã o grupo abre cedo.',
  'Boa noite! 🌙 Última partida? Então que seja a da vitória. O grupo fecha agora.',
  'Boa noite, galera! ⭐ Fim de fase por hoje. Quem dorme cedo acorda com a barra de energia cheia.',
  'Boa noite! 🕹️ Switch no dock, carregando junto com você. Até amanhã de manhã!',
  'Boa noite, pessoal! 🍄 O grupo fecha agora. Amanhã tem novidade e conversa nova por aqui.',
  'Boa noite! 🌠 Que os sonhos tenham trilha sonora boa e nenhum game over.',
  'Boa noite, gamers! 🎧 Tira o fone, apaga a luz e recarrega a vida. Até amanhã!',
  'Boa noite! 🌙 O grupo vai dormir e volta de manhã. Se rolou cupom hoje, dá uma olhada nas mensagens de cima.',
  'Boa noite, time! 😌 Hoje foi dia de jogo e de papo bom. Descansem, merecem.',
  'Boa noite, galera! 🎮 Salvando o jogo e fechando o grupo por hoje. Até logo!',
  'Boa noite! 💤 Quem for virar a noite no jogo, bom jogo. Quem for dormir, bons sonhos. O grupo descansa agora.',
  'Boa noite, pessoal da Phaze! 🌃 Agradecemos a companhia hoje. O grupo reabre de manhã.',
  'Boa noite! 🔋 Hora de recarregar o controle e você também. Amanhã a gente joga de novo.',
  'Boa noite, jogadores! 🌙 Que o backlog espere e o sono vença hoje. Grupo fechado até de manhã.',
  'Boa noite! ✨ Fim de mais um dia de fase boa. Descansa que amanhã tem continue.',
  'Boa noite, galera! 💚 Obrigado por estarem aqui. Durmam bem, o grupo volta de manhã.',
  'Boa noite! 🦉 Coruja gamer também precisa dormir. Até a próxima fase, amanhã!',
  'Boa noite, pessoal! 🎁 Fechamos o grupo por hoje. De manhã tem novidade e cupom pra ficar de olho, quando rolar.',
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
