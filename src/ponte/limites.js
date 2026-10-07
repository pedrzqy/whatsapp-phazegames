'use strict';

/**
 * Limites e disjuntor.
 *
 * Quatro camadas independentes. Cada uma protege de uma coisa diferente, e
 * qualquer uma sozinha barra o envio:
 *
 *   1. POR CLIENTE   — cliente floodando não consome a cota do fornecedor.
 *   2. POR FORNECEDOR— teto de ações/hora no chat da Taobao. É a camada que de
 *                      fato reduz risco de banimento da conta.
 *   3. DIÁRIO        — teto absoluto do dia. Rede de segurança contra bug em loop.
 *   4. DISJUNTOR     — congela tudo quando aparece verificação anti-bot.
 *
 * Os contadores vivem no arquivo de estado, não em memória: reinício do
 * container não pode zerar o limite e liberar uma rajada logo após incidente.
 */

const { dados, persist } = require('./estado');
const cfg = require('./config');

/** Incrementa um contador de janela e diz se estourou. */
function consumir(chave, teto, janelaMs) {
  const agora = Date.now();
  const atual = dados.limites[chave];

  if (!atual || agora - atual.inicio >= janelaMs) {
    dados.limites[chave] = { n: 1, inicio: agora };
    persist();
    return { permitido: true };
  }

  if (atual.n >= teto) {
    return {
      permitido: false,
      motivo: `limite "${chave}" atingido (${atual.n}/${teto})`,
      liberaEmSeg: Math.max(1, Math.ceil((atual.inicio + janelaMs - agora) / 1000)),
    };
  }

  atual.n += 1;
  persist();
  return { permitido: true };
}

/** Consulta sem consumir — para mostrar no painel/comando. */
function espiar(chave, teto, janelaMs) {
  const atual = dados.limites[chave];
  const valido = atual && Date.now() - atual.inicio < janelaMs;
  return { usado: valido ? atual.n : 0, teto };
}

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;

// ── Camada 1 — por cliente ──────────────────────────────────────────

function checarCliente(from) {
  return consumir(`cliente:${from}`, cfg.limites.clientePorHora, HORA);
}

// ── Camadas 2 e 3 — fornecedor e teto diário ────────────────────────

/**
 * Cota de envio ao chat da Taobao. Chamar SÓ na hora de despachar de verdade:
 * consumir aqui e desistir depois desperdiça cota.
 */
function checarEnvio() {
  const d = disjuntor();
  if (d.estado === 'aberto') {
    return { permitido: false, motivo: `disjuntor aberto: ${d.motivo || 'verificação anti-bot pendente'}` };
  }

  const hora = consumir(`fornecedor:hora`, cfg.limites.vendedorPorHora, HORA);
  if (!hora.permitido) return hora;

  const hoje = new Date().toISOString().slice(0, 10);
  return consumir(`fornecedor:dia:${hoje}`, cfg.limites.vendedorPorDia, DIA);
}

function painel() {
  const hoje = new Date().toISOString().slice(0, 10);
  return {
    hora: espiar('fornecedor:hora', cfg.limites.vendedorPorHora, HORA),
    dia: espiar(`fornecedor:dia:${hoje}`, cfg.limites.vendedorPorDia, DIA),
  };
}

// ── Camada 4 — disjuntor ────────────────────────────────────────────

function disjuntor() {
  return dados.disjuntor;
}

/** Minutos até a próxima tentativa de voltar sozinho: 2, 5, 10, 15, 15... */
function esperaSondaMs(n) {
  const lista = cfg.limites.sondaMinutos.length ? cfg.limites.sondaMinutos : [2, 5, 10, 15];
  return lista[Math.min(Math.max(n, 0), lista.length - 1)] * 60 * 1000;
}

/**
 * Congela a operação. Chamado quando o braço vê tela de verificação, ou
 * quando acumula falhas seguidas.
 *
 * Congelar é a resposta certa a captcha. Resolver por script acerta a posição
 * do slider e erra a biometria da trajetória (velocidade, aceleração, tremor)
 * — e cada tentativa falha é sinal de bot somada à conta. Parar e chamar um
 * humano custa 30 segundos; insistir custa a conta.
 *
 * Dois tipos de congelamento, e a diferença é quem desfaz:
 *   - automatico (falhas seguidas): tentarRecuperar() volta sozinho, com espera
 *     crescente. Falha em série costuma ser lentidão do outro lado ou a tela
 *     engasgada, e isso passa.
 *   - humano (captcha, ou o operador): só o #liberar. Insistir é o que custa a conta.
 *
 * @param {{automatico?:boolean, sondas?:number}} [opcoes]
 * @returns {boolean} true se ACABOU de abrir (para disparar o alerta uma vez só)
 */
function abrir(motivo, printPath, opcoes = {}) {
  const d = dados.disjuntor;
  const automatico = Boolean(opcoes.automatico) && cfg.limites.autoRecupera;

  if (d.estado === 'aberto') {
    // Captcha chegando com o congelamento automático em pé: vira humano e
    // avisa. Engolir isto deixaria o operador sem saber que agora é com ele.
    if (d.automatico && !automatico) {
      d.automatico = false;
      d.proximaSondaEm = null;
      d.motivo = motivo;
      d.printPath = printPath || null;
      persist();
      console.warn(`[ponte/disjuntor] congelamento virou manual — ${motivo}`);
      return true;
    }
    return false;
  }

  d.estado = 'aberto';
  d.motivo = motivo;
  d.printPath = printPath || null;
  d.abertoEm = Date.now();
  d.automatico = automatico;
  d.emObservacao = false;
  d.sondas = opcoes.sondas || 0;
  d.proximaSondaEm = automatico ? Date.now() + esperaSondaMs(d.sondas) : null;
  // Reabrir logo depois de uma volta (sondas > 0) herda o último aviso: é o que
  // deixa o alerta saber que acabou de avisar e não repetir.
  if (!opcoes.sondas) d.ultimoAvisoEm = null;
  d.lembretes = 0;
  persist();
  console.warn(`[ponte/disjuntor] ABERTO${automatico ? ' (volta sozinho)' : ''} — ${motivo}`);
  return true;
}

/**
 * Descongela. Quem chama com 'operador' é o #liberar; 'auto' é a volta sozinha
 * (opcoes.observar: a próxima falha reabre na hora, sem esperar três).
 *
 * Os prazos dos atendimentos em curso são empurrados: o tempo congelado não é
 * tempo de cliente sem resposta, e sem isto o primeiro tick depois da volta
 * expirava todo mundo de uma vez.
 */
function fechar(quem, opcoes = {}) {
  const d = dados.disjuntor;
  d.estado = 'fechado';
  d.motivo = null;
  d.printPath = null;
  d.falhasSeguidas = 0;
  d.falhasPor = [];
  d.fechadoEm = Date.now();
  d.liberadoPor = quem || 'operador';
  d.automatico = false;
  d.proximaSondaEm = null;
  d.emObservacao = Boolean(opcoes.observar);
  // A observação vale 15 min. Passou disso sem falha, a volta está provada o
  // bastante: uma falha no dia seguinte é falha nova, não "logo depois de liberar".
  d.observacaoAte = opcoes.observar ? Date.now() + 15 * 60 * 1000 : null;
  if (!opcoes.observar) d.sondas = 0;

  const prazo = Date.now() + cfg.fila.timeoutMinutos * 60 * 1000;
  for (const a of dados.atendimentos) {
    if (a.estado === 'ativo' && a.expiraEm && a.expiraEm < prazo) a.expiraEm = prazo;
    // avisoCongelado fica: o cliente ouve a instabilidade UMA vez por atendimento,
    // por mais que congele e volte no meio.
  }
  persist();
  console.log(`[ponte/disjuntor] fechado por ${d.liberadoPor}`);
}

/**
 * Falha SISTÊMICA do braço (a tela, o navegador, o outro lado). Falha que é do
 * pedido, não do sistema, nem chega aqui — ver resultadoTarefa.
 *
 * Abre quando juntam N falhas seguidas vindas de pelo menos M clientes
 * diferentes: um pedido que falha três vezes sozinho não derruba o atendimento
 * de ninguém. Voltando de um congelamento (emObservacao), uma falha basta.
 *
 * @param {string} [atendimentoId]  de quem era o envio que falhou
 * @returns {{falhas:number, abriu:boolean, reabriu:boolean}}
 */
function registrarFalha(detalhe, printPath, atendimentoId) {
  const d = dados.disjuntor;
  d.falhasSeguidas = (d.falhasSeguidas || 0) + 1;
  d.falhasPor = d.falhasPor || [];
  const quem = atendimentoId || `anon${d.falhasSeguidas}`;
  if (!d.falhasPor.includes(quem)) d.falhasPor.push(quem);
  persist();

  if (d.estado === 'aberto') return { falhas: d.falhasSeguidas, abriu: false, reabriu: false };

  if (d.emObservacao && d.observacaoAte && Date.now() > d.observacaoAte) {
    d.emObservacao = false;
    d.observacaoAte = null;
    d.sondas = 0;
  }

  if (d.emObservacao) {
    const abriu = abrir(`falhou de novo logo depois de voltar. Última: ${detalhe}`, printPath, {
      automatico: true,
      sondas: d.sondas || 0,
    });
    return { falhas: d.falhasSeguidas, abriu, reabriu: abriu };
  }

  if (d.falhasSeguidas >= cfg.limites.falhasParaAbrir && d.falhasPor.length >= cfg.limites.falhasClientes) {
    const abriu = abrir(
      `${d.falhasSeguidas} falhas seguidas, de ${d.falhasPor.length} cliente(s). Última: ${detalhe}`,
      printPath,
      { automatico: true },
    );
    return { falhas: d.falhasSeguidas, abriu, reabriu: false };
  }
  return { falhas: d.falhasSeguidas, abriu: false, reabriu: false };
}

function registrarSucesso() {
  const d = dados.disjuntor;
  if (d.falhasSeguidas || d.emObservacao) {
    d.falhasSeguidas = 0;
    d.falhasPor = [];
    d.emObservacao = false;
    d.observacaoAte = null;
    d.sondas = 0;
    persist();
  }
}

/**
 * Chamado a cada minuto. Se o congelamento é automático e a hora da próxima
 * tentativa chegou, descongela em modo de observação: o próximo envio de
 * cliente é o teste de verdade, e uma falha dele congela de novo na hora. Não
 * existe "teste a seco" do braço (ele só prova que funciona fazendo o passo),
 * então o pedido real é a sonda.
 *
 * Também pede ao braço uma recarga da tela (#recarregar): ele faz antes de
 * pegar a próxima tarefa, e é o que cura a aba engasgada.
 *
 * Só tenta com o braço vivo (bateu aqui há menos de 2 min). Com ele fora do
 * ar, descongelar não prova nada e só esconde o problema.
 *
 * @returns {{acao:'nada'|'adiou'|'fechou', congeladoMs?:number}}
 */
function tentarRecuperar(agora = Date.now()) {
  const d = dados.disjuntor;
  if (d.estado !== 'aberto' || !d.automatico) return { acao: 'nada' };

  if (!d.proximaSondaEm) {
    d.proximaSondaEm = agora + esperaSondaMs(d.sondas || 0);
    persist();
  }
  if (agora < d.proximaSondaEm) return { acao: 'nada' };

  d.sondas = (d.sondas || 0) + 1;
  const vivo = dados.coletaVistaEm && agora - dados.coletaVistaEm < 2 * 60 * 1000;
  if (!vivo) {
    d.proximaSondaEm = agora + esperaSondaMs(d.sondas);
    persist();
    return { acao: 'adiou' };
  }

  const congeladoMs = agora - (d.abertoEm || agora);
  fechar('auto', { observar: true });
  dados.recarregarPedido = true;
  persist();
  return { acao: 'fechou', congeladoMs };
}

module.exports = {
  checarCliente,
  checarEnvio,
  painel,
  disjuntor,
  abrir,
  fechar,
  registrarFalha,
  registrarSucesso,
  tentarRecuperar,
};
