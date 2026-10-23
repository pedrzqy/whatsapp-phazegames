'use strict';

/**
 * Idioma do cliente, pelo DDI do telefone.
 *
 * Regra unica para as mensagens da XPag (lembretes de pagamento e confirmacao):
 * o cliente fala a lingua do pais do numero dele. Espanhol para o Mexico (+52),
 * Colombia (+57), Chile (+56) e os demais paises hispanofalantes da America
 * Latina; portugues para todo o resto (Brasil, +55, e qualquer numero que nao
 * se reconheca). Os fluxos brasileiros da Nerix NAO usam isto.
 *
 * Recebe o numero no formato do WhatsApp (DDI + numero, so digitos), o mesmo
 * que telefone.paraWhatsApp devolve. Sem DDI o numero e ambiguo (um DDD 51 do
 * Brasil parece o Peru), por isso a duvida sempre cai no portugues.
 *
 * Fora de proposito: +1 (809/829/849, Republica Dominicana, divide o DDI com
 * EUA e Canada) e a Espanha. Ficam em portugues ate a loja atender esses
 * mercados.
 */

const DDI_ES = ['52', '57', '56', '54', '591', '593', '595', '598', '51', '58', '506', '507', '502', '503', '504', '505', '53'];

/** 'es' | 'pt' */
function idiomaDoTelefone(numero) {
  const d = String(numero == null ? '' : numero).split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!d) return 'pt';
  if (d.startsWith('55')) return 'pt';
  return DDI_ES.some((ddi) => d.startsWith(ddi)) ? 'es' : 'pt';
}

module.exports = { idiomaDoTelefone, DDI_ES };
