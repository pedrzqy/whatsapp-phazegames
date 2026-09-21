# Continuação — bot da Phaze Games

Copie este arquivo inteiro na primeira mensagem da próxima janela.

---

Você vai trabalhar no bot de WhatsApp da **Phaze Games**, loja brasileira de
jogos digitais. O código está em `C:\Users\pedrz\Downloads\EvolutionAPI`,
branch `main`. O repositório foi renomeado para
`github.com/pedrzqy/whatsapp-phazegames`; o remoto local ainda aponta para o
nome antigo (`whatsbot`) e o GitHub redireciona, então o push funciona.

Fale **português**. O dono não é programador.

---

## 0 · Antes de propor qualquer coisa, leia isto

Três coisas decidem se o seu trabalho vai servir ou atrapalhar:

**Ele opera do celular.** No meio do expediente, com a loja rodando. Quando
algo quebra, ele não tem teclado na mão. Ordem de preferência das soluções:
comando no WhatsApp (`#admin`, `#status`) → clique no Easypanel → URL que ele
salva → console de container (último recurso, e ele vai reclamar).

**A env vence o código.** Mudar um padrão em `config.js` ou `ponte/config.js`
não faz nada se a variável já existir no Environment do Easypanel. Isso já
custou três rodadas de investigação. Ao mexer num padrão, diga o nome exato da
variável e que ele precisa mudar (ou apagar) no painel.
**Exceção**: as 9 chaves do `#admin` moram no volume e **vencem** a env.
`#admin N padrao` apaga a escolha e devolve o valor do Environment.

**Commitou, pushou.** O Easypanel puxa do GitHub. Commit parado na máquina não
vira deploy, por mais que ele clique em Deploy. Se `git status -sb` mostrar
`[ahead N]`, **nada do que você fez está no ar**. Já aconteceu com 17 commits.

---

## 1 · O que existe

Três serviços no Easypanel, **deployados separadamente**:

| Serviço | O que é | Pasta |
|---|---|---|
| `whatsbot` | o bot, porta **3000** | `src/` |
| `braco` | navegador que opera o chat do outro lado (Playwright) | `braco-web/` |
| `evolution-api` | gateway do WhatsApp (Baileys) | de terceiros |

Sempre diga em qual deployar. Subir só um já causou bug várias vezes.

**Integrações:** Evolution API (WhatsApp), Nerix (loja/pedidos), DeepSeek (IA).

**O cérebro é o DeepSeek** (`deepseek-v4-flash`), uma chave só para tudo:
conversa com cliente e trabalho de bastidor. **O Claude saiu do projeto** em
setembro. Orçamento de poucos dólares por mês — não proponha modelo caro.

**Ele NÃO enxerga foto** (`VE_IMAGEM = false` em `deepseek.js`). Quando o
cliente manda print de erro, o bot pede o CÓDIGO do erro, que o `telas.js`
resolve sozinho, sem modelo. Isso é decisão, não limitação a consertar.

---

## 2 · Estado de hoje (21/09)

**Acabei de reverter dois commits, a pedido dele.** Ele tinha pedido "modo só
código" (desligar tudo menos o pedido de código de verificação) e o resultado
foi **nem atendimento, nem código**: o `#inicio` ficou mudo junto.

O motivo está em `handlers.js` e é o tipo de coisa que só se vê lendo a ordem:

- `recepcao.avaliar` (continuar um fluxo já aberto) roda na **linha 403/427**
- o portão do atendimento roda na **linha 486**
- as palavras de recomeço, incluindo `#inicio`, rodam na **linha 530**

Ou seja: quem já estava no meio do fluxo continuava, mas quem digitava
`#inicio` para **começar** batia no portão e não recebia nada. E `#inicio` é o
caminho que todo cliente conhece, porque está no rodapé de toda mensagem.

Hoje `src/` está **idêntico ao estado do dia 19**, que é quando rodava bem.

**Não refaça o "só código" sem ele pedir de novo.** Se pedir: teste `#inicio` e
o passo da foto de ponta a ponta ANTES de ele encostar em qualquer interruptor.

---

## 3 · Regras que não se negociam

1. **Nenhuma mensagem de WhatsApp** pode conter "fornecedor", "Taobao",
   "braço", "robô", "bot", "automático/automaticamente", "script", nem
   caractere chinês — **inclusive as do operador**, porque saem pelo mesmo
   número comercial. A lista é única, em `politica.js` →
   `vocabularioProibido()`. O `teste-ponte.js` falha se algo escapar; ele já
   pegou isso várias vezes.
2. **Nada de travessão (—)** no que sai. Ninguém digita isso no WhatsApp; é a
   marca mais óbvia de texto gerado, e o dono reclamou. A rede está no
   `sender.normalizeWhatsApp`, mas o prompt também não deve usar: o modelo
   imita o estilo que lê.
3. Negrito no WhatsApp é **um** asterisco. Dois é markdown e aparece cru.
4. **Erro técnico nunca vira mensagem ao cliente.** `politica.motivoNeutro()` é
   catálogo fechado; o texto do erro nunca é repassado.
5. Nunca resolver captcha automaticamente. Nunca ler código por OCR.
6. Preço em yuan nunca chega ao cliente (MARKUP=0).
7. O cliente nunca vê comando de operador (`#ok` etc.) e nunca ouve que o
   pedido dele "vai ser encaminhado". Ele também não recebe aviso de falha.
8. Para o outro lado **só sai chinês**, sempre traduzido. Há trava no
   `despachar`.
9. **O bot NÃO responde em grupo.** As únicas mensagens que saem para o grupo
   são os anúncios agendados e as saudações. Esse caminho foi **removido** do
   código, não desligado: `handleGroupMessage` não existe mais.

---

## 4 · Antes de todo commit

```bash
npm run teste
```

São cinco suítes encadeadas com `&&`:
`teste-ponte.js teste-tools.js teste-vendas.js teste-deepseek.js teste-webhook.js`.
Rodam offline, em menos de um segundo. Saída 0 significa que as cinco passaram.

E as do braço:

```bash
cd braco-web && npm run teste
```

**Nunca commite com a suíte vermelha.** Já aconteceu aqui e ele disse que não
deveria ter acontecido.

Mensagem de commit em **texto puro, sem acento** — o shell desta máquina quebra
em acento, parêntese e interrogação. Se a mensagem for longa, escreva num
arquivo e use `git commit -F`.

**Cuidado com heredoc nesta máquina:** o terminador chega com CRLF e o bash não
casa, então `cat > arquivo <<'FIM'` falha com "unexpected EOF". E `\n` ou `\b`
dentro de string JavaScript escritos por heredoc viram **caractere de controle
real** no arquivo. Uma vez o `\b` virou backspace num regex e **todos os
comandos do operador pararam de funcionar de uma vez**, com o arquivo parecendo
correto na leitura. Para escrever arquivo ou editar código com escape: **use a
ferramenta Write/Edit**, não o shell.

---

## 5 · Os comandos dele

```
#status     diagnostico: WhatsApp conectado, loja, avisos de venda, IA
#admin      painel de 9 interruptores (liga/desliga sem deploy)
#grupo      abre/fecha o grupo na mao, para testar
#fila       a fila de pedidos de codigo
#teste      vira cliente por 30 min (FURA o interruptor de atendimento)
#auto       copiloto (cada envio espera #ok) x autopiloto
#atender    liga/desliga o atendimento
#casos      quanto o bot resolveu sozinho
#ajuda      a lista
```

Todo comando passa por um portão de regex em `operador.js`. Comando novo tem
que entrar **lá também**, senão ele é tratado como mensagem de cliente.

**Painel `#admin`, na ordem que ele decora:**

| # | Chave | O que faz |
|---|---|---|
| 1 | atendimento | responder cliente no WhatsApp |
| 2 | ia | a IA responde além do menu |
| 3 | vender | fecha a compra e manda o Pix no chat |
| 4 | codigos | busca o código com o outro lado |
| 5 | aprovacao | nada sai sem o `#ok` dele |
| 6 | repertorio | usa as frases prontas com o outro lado |
| 7 | conferir | pergunta se ativou, 3h depois |
| 8 | reativar | chama quem comprou e sumiu |
| 9 | grupo | fecha o grupo de madrugada |

**Chave nova entra no FIM.** Nunca no meio: ele decora a posição, não o nome.

---

## 6 · Mapa dos arquivos

```
src/handlers.js       o caminho de toda mensagem. A ORDEM importa (ver 2)
src/ai.js             prompt, historico, laco de ferramentas, copy
src/deepseek.js       a borda com a API, disjuntor, teto por dia
src/memoria.js        ficha do cliente (45 dias) + assunto atual (48h)
src/knowledge.js      os FATOS da loja (vao literais ao menu E ao prompt)
src/menu.js           o menu numerado
src/telas.js          telas de erro conhecidas, com a resposta pronta
src/tools.js          as 6 ferramentas da IA
src/chaves.js         o painel #admin
src/vendas.js         ciclo de venda, webhook da Nerix, Pix na hora
src/posvenda.js       "conseguiu ativar?" e reativacao
src/community.js      anuncios no grupo, horario do grupo, saudacoes
src/exemplo.js        as duas fotos de exemplo (assets/)
src/ponte/            tudo do outro lado: fila, janela, recepcao, politica
```

**As 6 ferramentas:** `buscar_produtos`, `pedir_codigo_fornecedor`,
`consultar_pedido`, `meus_pedidos`, `criar_pedido`, `falar_com_atendente`.

**A memória nunca vai no system prompt.** Cache é casamento de prefixo: um byte
diferente por cliente zera o cache inteiro. Ela entra no **turno de usuário**,
depois do breakpoint. Se você mexer nisso, mexeu no custo.

---

## 7 · Armadilhas que já custaram caro

**`/app/data` — NÃO SE SABE se tem volume montado, e isso é urgente.** Lá moram:
quais chaves já foram entregues, os interruptores do `#admin`, a memória da IA,
os contatos e o estado da comunidade. Sem volume, **todo deploy apaga isso** — e
chave entregue é dinheiro. Pergunte no começo e faça ele conferir no Easypanel.
Já foi levantado três vezes e nunca respondido.

**Interruptor decorativo.** Aconteceu duas vezes: duas fontes para o mesmo
estado, e a errada vencia. O `#admin` mudava de símbolo e nada acontecia.
Regra: **uma fonte de verdade**, e quem mexe escreve nela.

**Estado assumido não é estado sabido.** O portão do grupo guardava o que ele
*achava* e só agia quando diferia — um fechamento que falhou o deixou trancado
para sempre. Hoje ele reaplica de hora em hora. **Prefira reconciliar a
reagir**: compare o estado desejado com o aplicado a cada tique.

**A fila humanizada cria corrida.** Todo envio espera reação (2-6s), "digitando"
e espaçamento — dá uns 30 segundos entre mensagens. Duas mensagens do mesmo
cliente são processadas em paralelo e o estado envelhece no meio. Já gerou print
de cliente recebendo menu depois de ter sido transferido. Marque ANTES de
enviar: `marcar(codigo, passo)` faz o check e a escrita num passo só.

**Os testes precisam ser trancados contra o ambiente.** O `.env` local tem chave
de verdade. `delete process.env.X` **não basta**: o `config.js` chama dotenv,
que relê o `.env` e repõe a chave. Use `process.env.X = ''`. As suítes já fazem
isso no topo; copie o bloco se criar uma nova. E honre `PONTE_DATA_DIR` em todo
arquivo de estado novo — quatro já honram.

---

## 8 · Pendências

**Operacional (dele, mas cobre):**

1. **Confirmar o volume em `/app/data`** no whatsbot. O mais importante da lista.
2. `#admin 1 on` + Deploy, para voltar ao estado do dia 19.
3. `PONTE_TIMEOUT_MIN=20` no Environment (o código já usa 20; a env pode estar
   com 240, e a env vence).
4. **Rotacionar as chaves que apareceram em print**: Nerix, DeepSeek, Evolution,
   e o `ADMIN_TOKEN`.
5. Tirar o domínio público da `evolution-api` — o painel dela está exposto.
6. Desligar a **mensagem de saudação do WhatsApp Business** no app. Ela promete
   PlayStation, que não se vende mais, e manda para um grupo que não existe.
   **Não é código nosso** — investiguei achando que era.

**Aprovado e não construído:**

- **Evento de indicação**: cada participante recebe um link
  `wa.me/NUMERO?text=... CODIGO`; quem clica cai no bot, o indicador ganha o
  ponto, o amigo recebe o link do grupo. O WhatsApp não tem link por pessoa, por
  isso o código viaja na mensagem. Faltou decidir: conta entrada ou conta compra?
- **Reescrever os 8 fatos do `knowledge.js`** com a régua de copy nova. Ele
  aprovou o exemplo e nunca disse "vai".
- **Reenviar o último código** quando o cliente perde a mensagem. Hoje isso
  dispara um pedido NOVO ao outro lado e gasta cota.
- **Serializar o atendimento por contato** (ver a corrida na seção 7).

---

## 9 · O padrão que este projeto segue

**Regra fixa antes do modelo.** Pedido de código, telas de erro e opções de menu
são estereotipados: regex não custa token, não alucina, não muda de ideia e
funciona com a IA fora do ar. O modelo entra só onde a conversa é mesmo livre.

**Filtrar na porta, não em cada chamada.** Vocabulário proibido, markdown,
travessão e caractere chinês são consertados num lugar só, na saída. Depender de
cada chamador lembrar da regra é o que já falhou.

**O que nasce perigoso nasce desligado.** Repertório e reativação começam off e
avisam do risco antes de ligar.

**Todo desfecho silencioso vira log ou contador.** Filtro que descarta calado,
comando ignorado, cache que parou — cada um custou uma investigação, e cada um
hoje tem uma linha que aparece. O `#status` nasceu disso: foi ele que achou o
`data.order` que segurava os avisos de venda por dias.

---

## 10 · Como trabalhar com ele

- Direto, sem rodeio. Ele não é técnico: explique em português claro o que
  mudou e o que ele precisa fazer no painel, dizendo **onde clicar**.
- Comentário no código explica **por que**, não o quê. Vários bugs daqui foram
  descobertos na marra e o motivo precisa ficar registrado.
- **Não use workflows nem rodadas de refutação** — gasta crédito à toa.
- Quando errar, corrija numa frase e siga. Sem discurso.
- Comando que ele precisa rodar vai em bloco próprio, uma linha.
- Ele manda print em vez de log. Peça o log do console quando o print não
  bastar — foi o log que resolveu dois bugs que o print escondia.
- Não diga "tudo certo" sem ter rodado os testes.

**Se ele relatar um bug:**

1. **Confira a data do build no log** antes de qualquer coisa. O log de partida
   do whatsbot mostra `build de AAAA-MM-DD HH:MM UTC`. Ele tem histórico de
   esquecer o Deploy, e isso já custou três rodadas de investigação.
2. **Reproduza rodando o caminho de verdade**, não lendo o código. Metade dos
   bugs foi diferente do que a leitura sugeria.
3. Quando achar, **escreva o teste que falha** antes de corrigir.
4. Comente o porquê no código, com o sintoma que o bug produzia.

**Comece perguntando o que ele quer fazer hoje.** Não saia mexendo.
