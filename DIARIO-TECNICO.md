# Diário Técnico — Jornada completa da Integração Kommo ↔ Clínica nas Nuvens

> Este arquivo concatena **todo o contexto** do trabalho: ordem cronológica do que foi pedido,
> investigado, descoberto, decidido, errado e corrigido — com os números reais medidos ao vivo.
> É o "registro da obra". Para a especificação final (como o sistema é hoje) ver `ESPECIFICACAO-TECNICA.md`;
> para o objetivo ("o que deve ser") ver `novo arquivo mae escopo.md`; para o snapshot, `INVENTARIO.md`.
>
> Período coberto: 2026-06-23 a 2026-06-27.

---

## ÍNDICE CRONOLÓGICO
1. Ponto de partida e a decisão "opção 2"
2. Investigação do bug do C1 (o incidente dos 20 leads)
3. Mapeamento das regras de negócio reais (com o dono)
4. /discover: IDs reais dos funis e etapas
5. Os 5 prints do CNN: tipos e status reais → roteamento corrigido
6. "Atendimento Social só existe em produção" → roteamento por nome
7. Regra de segurança: chave de produção do CNN é só leitura
8. Tabela de status 11×2 e decisões de roteamento
9. Fase 1 — infraestrutura multi-ambiente + trava de escrita
10. Fase 2 — descoberta (contagem de leads, tipos, enums)
11. O lead "perdido" do Pós-Venda → quirk de contagem do Kommo
12. Fases 3 e 4 — roteamento em A3/A4 + Função 2 (véspera) + auditoria
13. Dry-runs em produção + o timeout do A3 → orçamento
14. A lista de agendas de amanhã → 5 problemas reais encontrados
15. Diagnóstico: "CNN xxx", tarefas internas, telefone, cancelados
16. "50 redondo demais" → investigação de paginação
17. O teto de 50 sub-requests confirmado + D1 não conta
18. Decisão de arquitetura: free + sync em etapas + cron 1 min
19. Pivô: de "cursor+lote" para "fila-em-D1"
20. Implementação da fila + medições (102s → 13s) + piloto
21. Backfill completo (350 mapeados, 52 criados, 0 erros)
22. A3 e F2 na fila, validados em dry
23. Documentação
24. Estado atual e o que falta (o flip)

---

## 1. Ponto de partida e a decisão "opção 2"
**Contexto inicial:** projeto `kommo-cnn` em `D:\clarissa-bergmann\kommo-cnn`. As funções A1, A2, A3, A4
constavam como "deployadas e validadas". Decisão registrada do dono: **opção 2** — religar o cron com
A2+A3, deixar A4 manual, e limpar os endpoints de teste.

**O que foi feito:** li o `src/index.ts` inteiro e o `wrangler.toml`. Estado encontrado:
- Cron: `0 18 * * *` (15h BRT) → `cronLembreteD1` (C1); `*/10 * * * *` → `cronSyncStatus` (C2).
- Funções novas A2/A3/A4 existiam no código e em endpoints `/debug-*`, mas **fora do cron** (o cron
  rodava o legado C1/C2).
- Banco D1 `kommo-cnn-db` com tabelas `agendamento_sync`, `cursores`, `mapeamento`, `agenda_sync`.

**Princípio de trabalho do dono (reforçado):** apresentar plano e aguardar "ok" antes de qualquer
código/comando; ser econômico. (Por isso cada fase abaixo foi confirmada antes de executar.)

## 2. Investigação do bug do C1 (o incidente dos 20 leads)
**Pergunta do dono:** "o `cronLembreteD1` valida a DATA do agendamento antes de mover? Só move se o
`ID Agenda CNN` corresponde a uma consulta marcada pra amanhã?"

**Descoberta (lendo `selectLeadsLembreteD1`):** NÃO. O C1:
- ✅ valida que a **cópia local** do campo `AGENDAMENTO` (no Kommo) cai em amanhã;
- ✅ exige que `ID Agenda CNN` e `ID Paciente CNN` estejam **preenchidos** (só existência);
- ❌ **nunca consulta o CNN** — não verifica se a agenda real é de amanhã nem se está ativa/cancelada.

**Causa-raiz do incidente:** um lead guardava o `ID Agenda CNN` de uma agenda **CANCELADA** no CNN,
mas com `AGENDAMENTO` (cópia local) apontando pra amanhã → `c1_moveria: true` → o lead foi movido para
"Confirmação" (e disparou Salesbot) mesmo com a consulta cancelada. **Lição:** validar contra a fonte
(CNN), nunca confiar só no cache local (vira a regra §7.5).

## 3. Mapeamento das regras de negócio reais (com o dono)
O dono detalhou o que o sistema **deve** fazer (não o que existia):
- **Tipo de agendamento (CNN):** Retorno, encaixe, atendimento social, procedimento.
- **Atendimento Social** → Funil de **Captação**, etapa "Confirmação de consulta".
- **Retorno/encaixe/procedimento** → Funil de **Pós-Venda**, etapa "Confirmação de agendamento".
- **Mover só UMA vez** e **registrar em log**.
- Ignorar a regra antiga de "não mover se já está em etapa acima".

**Constatação:** o sistema legado tinha **um único pipeline** (Captação). Pós-Venda e roteamento por
tipo **não existiam** — era preciso construir uma camada nova tocando A3, A4, C1/F2 e W1.

Também fiz o **inventário completo** do sistema atual (a pedido do dono) → `INVENTARIO.md`, e li o
documento mãe (`novo arquivo mae escopo.md`, v1.1) comparando o objetivo com o estado real (gaps:
Função 3/orçamento inexistente, ledger de auditoria inexistente, IDs hardcoded vs resolução por nome).

## 4. /discover: IDs reais dos funis e etapas
Rodei `/discover` (GET autenticado). Resultado — os 3 funis reais do Kommo:
- **Funil de Captação `13847079`**: Leads de entrada (106848271), primeiro contato (106848615),
  consulta agendada (106848619), **Confirmação de consulta (107785399)**, consulta confirmada
  (106848623), avaliação realizada (106848627), tratamento proposto (106848631), Follow-up (107789355),
  tratamento fechado (142), Consulta cancelada–perdido (143).
- **Funil de Pós - Consulta `13947295`** (não usado).
- **Funil de Pós - Venda `13950431`**: ..., cliente ativo (107658911), **confirmação de agendamento
  (107974651)**, ..., tratamento concluído (142), Venda perdida (143).

→ destino do Grupo B confirmado: Pós-Venda `13950431` / confirmação de agendamento `107974651`.

## 5. Os 5 prints do CNN: tipos e status reais → roteamento corrigido
O dono enviou prints do CNN real. **Tipos de atendimento:** Atendimento Social, Cirurgia,
Consulta/Avaliação, Cortesia, Encaixe, Encaminhamento - INTERNO, Pequenas Cirurgias, Procedimento,
Retorno. **Status:** A confirmar, Confirmado pelo paciente, Confirmado, Em espera, Pagamento,
Pré-atendimento, Em andamento, Finalizado, Cancelado pelo profissional, Cancelado pelo paciente, Faltou.

**Regra de roteamento CORRIGIDA (substituiu a anterior):**
- **Grupo A** = `Atendimento Social` OU `Consulta/Avaliação` → Captação / "consulta agendada"; na
  véspera (15h) → "Confirmação de consulta" (107785399).
- **Grupo B** = qualquer outro tipo (Cirurgia, Cortesia, Encaixe, Encaminhamento-INTERNO, Pequenas
  Cirurgias, Procedimento, Retorno) → Pós-Venda / "cliente ativo"; na véspera → "confirmação de
  agendamento" (107974651); enquanto na Pós-Venda só atualiza horário (não move).
- **Tipo desconhecido → não faz nada** (Decisão 2, confirmada pelo dono).

## 6. "Atendimento Social só existe em produção" → roteamento por nome
O dono avisou que "Atendimento Social" **não existe no sandbox**, só em produção. **Consequência de
arquitetura:** os IDs de tipo-consulta **diferem entre ambientes** e alguns nem existem no sandbox →
**não dá para hardcodar ID nenhum**. Decisão: **roteamento por NOME em runtime** — o código pega
`/tipo-consulta/lista`, monta um mapa `idTipoConsulta → nome normalizado` (cache por ambiente) e
classifica pelo nome. Os IDs de pipeline/etapa do **Kommo**, esses sim, ficam hardcoded (conta única,
estáveis).

## 7. Regra de segurança: chave de produção do CNN é só leitura (§7.8)
O dono impôs: o CNN **não tem chave só-leitura** (a mesma credencial lê e escreve), então vira **regra
comportamental inviolável** — com a chave de **produção**, **só `GET`**, nunca `POST/PUT/DELETE` até
liberação explícita; confirmar antes de cada uso.

**Implementação:** secrets de produção cadastrados pelo dono — `CNN_CID_PRODUCTION`,
`CNN_BASIC_USER_PRODUCTION`, `CNN_BASIC_PASS_PRODUCTION` (trio completo; user/pass diferem do sandbox).
Trava por código: `assertCnnWritable(target,…)` **lança erro** se `target==="production"` em
`cnnPost`/`cnnPut` (defesa em profundidade). Documentado no INVENTARIO (§0) e no escopo mãe (§7.8), e
salvo na memória do projeto.

## 8. Tabela de status 11×2 e decisões de roteamento
O dono definiu o mapa completo (11 status × 2 grupos):
- **Grupo A:** Confirmado/Confirmado pelo paciente → "consulta confirmada"; Faltou → "primeiro
  contato"; Cancelado (paciente/profissional) → "Cancelada–perdido"; Finalizado → "avaliação
  realizada"; operacionais (Em espera, Pré-atendimento, Em andamento, Pagamento) → não move.
- **Grupo B:** regra geral = continua **cliente ativo** (sai só manualmente); então Confirmado,
  Cancelado, Faltou, Finalizado → "cliente ativo"; operacionais → não move. Saída de "cliente ativo"
  só pela véspera (→ confirmação de agendamento) e volta depois.
- **Decisão 2 confirmada:** tipo desconhecido → não faz nada.

**Nota técnica:** os nomes dos status na UI ≠ enums da API. Confirmados no código: `AGENDADO`,
`CONFIRMADO_PACIENTE`, `FINALIZADO`, `CANCELADO`, `CANCELADO_PACIENTE`; os demais a confirmar ao vivo.

## 9. Fase 1 — infraestrutura multi-ambiente + trava de escrita
Implementado (aditivo, sem tocar no cron):
- `type CnnTarget = "sandbox" | "production"`; `cnnCreds`/`cnnHeaders` por ambiente; `assertCnnWritable`.
- `resolveTiposConsulta(env, target)` (cache 1h por ambiente); `grupoDaAgenda`; `MAPA_STATUS`;
  `destinoStatus`; `VESPERA_DESTINO`; constantes Pós-Venda.
- `Env` ganhou os 3 secrets `_PRODUCTION`.
- `/discover?env=` + novo `/debug-cnn-shape` (lê tipos + amostra de agendas, mostra grupo/destino).

Validação: `tsc` (só erros pré-existentes em código legado) + dry-run do `wrangler` (bundle compila).
**Primeiro deploy falhou:** token Cloudflare restrito por IP recusou o IP do ambiente (`code 9109`).
Dono ajustou; deploys passaram a funcionar (precisei fixar `CLOUDFLARE_ACCOUNT_ID`).

## 10. Fase 2 — descoberta (contagem de leads, tipos, enums)
- **Contagem de leads (Kommo prod):** inicialmente `/discover` paginado deu **2.273**, todos em Captação.
- **Tipos sandbox:** genéricos (Consulta, Cirurgia, Encaixe, Encaminhamento, Exame, Pré-Natal,
  Reconsulta) — "Atendimento Social" ausente, como o dono avisou.
- **Produção (`/debug-cnn-shape?env=production`, GET/leitura, com OK do dono):** 9 tipos reais, todos
  classificaram certo (Grupo A=374, B=126, fora=0 numa amostra de 500). Enums de status reais achados:
  `FINALIZADO, CANCELADO_PACIENTE, FALTOU, AGENDADO, CANCELADO, EM_ESPERA` (+ depois `CONFIRMADO`).
  Estrutura: o tipo vem em `idTipoConsulta` (campo único); `procedimentos[]` também presente.

## 11. O lead "perdido" do Pós-Venda → quirk de contagem do Kommo
O dono desconfiou: "no pós venda tem 1 lead, você não viu?". Estava certo. Investigação:
- `GET /leads` **sem filtro** retornava sempre os mesmos 2.273, todos Captação — e `filter[...pipeline_id]`
  **sozinho era ignorado** pelo Kommo (mesmo bug do `filter[status_id]`).
- Refiz a contagem **por etapa** (`filter[statuses][0][pipeline_id]+[status_id]` + guarda no código):
  **Captação 2.450** (1.153 primeiro contato, 1.117 cancelada–perdido, **177 Incoming**, 2 consulta
  agendada, 1 consulta confirmada), **Pós-Venda 1** (lead 18265606 em "Incoming leads"), Pós-Consulta 0.
  **Total real: 2.451.**
- **Quirk descoberto:** `GET /leads` sem filtro **exclui leads "Incoming"/unsorted** (faltavam 177+1).
  Varredura real exige filtro por etapa. Registrado no INVENTARIO.

## 12. Fases 3 e 4 — roteamento em A3/A4 + Função 2 (véspera) + auditoria
- **Fase 3:** `moveLeadToStage` ganhou parâmetro de pipeline; A3 (`syncCnnParaKommo`) e A4
  (`backfillCadastros`) passaram a rotear por grupo (`grupoDaAgenda` + `MAPA_STATUS`), criar/mover no
  pipeline certo, e aceitar `?env=`. Tipo fora de A/B → não faz nada.
- **Fase 4:** Função 2 `cronVespera` (CNN-driven: lista agendas de amanhã no CNN, reconfirma na fonte
  §7.5, roteia por grupo, idempotente). Novas tabelas D1: `lembrete_d1` (chave composta) e `auditoria`.
- **Teste E2E no sandbox (escrita real):** criei agenda Encaixe (Grupo B) para o telefone de teste →
  F2 moveu o lead 17488447 para "Pós-Venda: Confirmação de Agendamento"; rodei de novo → `ja_enviados=1`
  (idempotência provada). Conferido no Kommo. Depois restaurei o lead.

## 13. Dry-runs em produção + o timeout do A3 → orçamento
Com OK do dono (read-only):
- **A4 prod dry:** 614 agendas, `pulados_tipo=0` (roteamento cobre 100% dos tipos reais).
- **A3 prod dry:** **estourou o timeout de 2 min** — 614 agendas × 1 lookup Kommo cada era pesado demais
  numa request. **Correção:** `maxLookups` (orçamento de buscas por execução) com `adiados` para a
  próxima rodada. (Mais tarde isso evoluiu para o orçamento global de sub-requests.)

## 14. A lista de agendas de amanhã → 5 problemas reais encontrados
Gerei a lista detalhada de cada agenda de quinta (2026-06-25, produção, 50 agendas). O dono encontrou:
1. "Acompanhar TNI" / "Acompanhar Doutor Julio" não são pacientes — são **tarefas internas**.
2. Pacientes "CNN XXXXX" não aparecem na agenda visual — de onde vêm?
3. Eduardo Cardoso (16:30) e Adriana Gheller (17:15) têm telefone mas sumiram do CSV.
4. Rodrigo Borges (13:30) também sumiu.
5. Cancelados: vincular só Grupo A; cancelados do Grupo B → cliente ativo.

## 15. Diagnóstico: "CNN xxx", tarefas internas, telefone, cancelados
Investigação (sem chutar, com dump cru):
- **#2/#3/#4 são o MESMO bug.** `/agenda/lista` **não retorna nome** (só `idPaciente`); o nome vinha
  de `/paciente/{id}`. Provei rodando o preview 2× num dia cheio: a lista de "CNN xxx" **variava** entre
  rodadas (28 agendas = 0 falhas; 48 = 13 e depois 15, com 2 diferentes) → falha **transitória**, não
  dado real. Eduardo/Adriana/Rodrigo nunca sumiram — apareciam como `CNN <id>` por falha de lookup.
- **#1 tarefas internas:** dump cru de uma "Acompanhar TNI" mostrou telefone **(51) 11111-1111**,
  `idRotulo` **null** (não serve), tipo/local/executor reais. **Sinal confiável = telefone falso** →
  `isTarefaInterna` (vazio / <10 dígitos / ≤2 dígitos distintos).
- **Telefone (§7.1):** o CNN tem formatos mistos (com/sem DDI 55, com/sem 9º dígito). Implementei
  `phoneKey` (DDD + últimos 8). Re-rodando o A4 dry: de 40 "criar" passou a **30 vincular + 10 criar**
  (sem a correção, teria criado 30 cards **duplicados**). Zero duplicatas por formato.
- **Desempate B-ganha:** paciente com agenda A e B no mesmo dia → vai para B. Aplicado em A4 e F2.
- **#5 cancelados:** Grupo B cancelado → cliente ativo (já estava); Grupo A cancelado → Cancelada–Perdido.

## 16. "50 redondo demais" → investigação de paginação
O dono desconfiou do número 50 ("redondo demais, não é limite de paginação?"). Investigado com `/debug-raw`:
- **Amanhã: 50 é real** (página 0 = 50, `totalPaginas: 1`, página 1 vazia).
- **Quirk:** o CNN **ignora `registrosPorPagina=200` e capa em 100/página**; mas o loop usa
  `totalPaginas`, então lê tudo (janela 90d = 639 agendas, 7 páginas).
- **Filtro de data provado:** contagem por dia (domingo 2026-06-28 = 0; 2027 = 0; 2020 = 0; dias úteis
  45-56). Se não filtrasse, todo dia daria o mesmo número grande. Registrado no INVENTARIO.

## 17. O teto de 50 sub-requests confirmado + D1 não conta
Ao investigar os "CNN xxx", a causa real apareceu: **teto de 50 sub-requests (`fetch`) por invocação**
do plano free. Provado com `/debug-nomes?force=1`: estourou na **50ª chamada** com o erro literal
`"Too many subrequests by single Worker invocation"`. O preview fazia nome+lead por agenda (~2×50=100) →
tudo após a 50ª falhava → "CNN xxx" **e** lead não achado (mostrava "criar" quando era "vincular").
- **Correção do CSV:** 2-pass (nomes só-CNN + leads só-Kommo, cada um < 50, fundidos localmente) →
  36/36 nomes resolvidos, e as ações se corrigiram (vincular subiu de 12→23).
- **`/debug-d1cost`:** 200 queries D1 OK + fetch estourou em 50 → **D1 NÃO conta** no teto. Definiu o
  tamanho do lote.

## 18. Decisão de arquitetura: free + sync em etapas + cron 1 min
Relatório de consumo apresentado ao dono. Decisões dele:
- **Plano FREE** (custo zero inegociável; uso comercial). Avaliada e descartada a **Vercel** (Hobby
  proíbe uso comercial → risco de takedown). Cloudflare Workers free permite comercial.
- **Sync em etapas** (lotes) + **cron de 1 minuto** (mínimo do Cloudflare; 1.440/dia = 1,4% de 100k).

## 19. Pivô: de "cursor+lote" para "fila-em-D1"
A 1ª implementação de escala usou **cursor de offset** (`a3_offset`/`a4_offset`). O dono decidiu migrar
para **fila-em-D1**, com bons argumentos (que eu havia apontado): (a) o cursor espreme tudo no recurso
escasso (50 fetch) enquanto invocações/dia sobram; (b) o offset numa lista que **muda entre ticks**
(encaixes/cancelamentos) pode pular itens. Cloudflare Queues resolveria, mas é **pago** → fora. Fila à
mão em D1 (free). Mantidos: `bumpSubreq`/`resetSubreq`, filtro de interno, regras de cancelado, §7.8,
trava de ano, anti-ressurreição, desempate B-ganha (agora no produtor).

## 20. Implementação da fila + medições (102s → 13s) + piloto
- **Schema `fila_trabalho`** (chave UNIQUE, tipo, status, tentativas, payload…) + helpers (enfileirar
  em lote, puxar pendentes, marcar feito/erro com retry até 4×, stats).
- **Produtor A4** (1 item/paciente não-mapeado, desempate B-first) + **consumidor A4** (vincular/criar)
  + **consumidor genérico** (puxa lote, para no orçamento) + `/debug-tick`.
- **Medições:** D1 confirmado não-contar. Custo ~1,4 fetch/item (vincular=1, criar=3). **Gargalo achado:**
  o 1º produtor levou **102s** por 314 leituras+inserts D1 **sequenciais**. Otimização: carregar
  mapeados em **1 query** (`getMapeamentoIdSet`) + **DB.batch** nos inserts → **13s**.
- **Piloto real (escrita no Kommo):** 6 ticks, 60 itens, **0 erros**, subreq 10-18/tick. 11 cards
  criados (com nome+leadId) — conferidos pelo dono no Kommo (Pós-Venda/Cliente Ativo).

## 21. Backfill completo (350 mapeados, 52 criados, 0 erros)
Com OK do dono, escoei a fila:
- **Janela 14d:** 21 ticks, fila zerada, 34 criados + 212 vinculados, 0 erros.
- **Janela 90d (histórico, 1×):** produtor achou só 33 novos (302 já mapeados pelos 14d) → drenados.
- **Auditoria final:** **350 pacientes mapeados; 52 cards criados (20 Grupo A → Captação, 32 Grupo B →
  Pós-Venda); 298 vinculados; 0 erros.** Descoberta: ~88% dos "não-mapeados" já tinham lead → backfill
  é mais vínculo que criação.

## 22. A3 e F2 na fila, validados em dry
Estendi a fila para os outros fluxos (testáveis via `/debug-tick`, sem tocar o cron):
- **Produtor/consumidor A3** (sync): enfileira agendas mapeadas com mudança de status/hora; baseline na
  1ª vez (não move); depois move por status. Dry: **0 não-mapeados** (o backfill mapeou todo mundo),
  baseline ok, ≤8 subreq.
- **Produtor/consumidor F2** (véspera): dedup B-first por lead, idempotente (`lembrete_d1`), move pra
  confirmação. Dry p/ segunda 2026-06-29: 48 agendas → 33 leads, 0 não-mapeados, ≤2 subreq.
- Bulk-loaders D1 (`getMapeamentoLeadMap`, `getAgendaSyncMap`) para o produtor não fazer N round-trips.

## 23. Documentação
- `INVENTARIO.md` — snapshot operacional (regra §0/§7.8, quirks §0.1, contagens reais).
- `ESPECIFICACAO-TECNICA.md` — especificação completa (20 partes + "Entenda do zero" + contratos de API
  + código central + diagrama de fluxo).
- `DIARIO-TECNICO.md` — este arquivo (a jornada).
- Memória do projeto atualizada (regra do CNN prod só-leitura).
- CSVs de conferência gerados (`backfill-preview-*.csv`, `IMPORTACAO-segunda-2026-06-29.csv`).

## 24. Estado atual e o que falta (o flip)
**Pronto e no ar:** backfill concluído; A3/A4/F2 na fila validados; orçamento + filtro interno +
cancelados + §7.8 + anti-ressurreição no lugar. **O cron AINDA roda o legado C1/C2.**

**Falta (o "flip", aguardando OK):** trocar `scheduled()` pelo dispatcher (resetSubreq → 1 produtor por
horário → consumidores), `wrangler.toml` crons → `["* * * * *"]`, aposentar C1/C2. A 1ª hora pós-flip é
uma varredura de **baseline** (não move em massa). **A2 fica de fora** (escreve no CNN → bloqueado §7.8)
até liberação de escrita CNN.

**Decisões do dono pendentes p/ o flip:** OK ao baseline sobrescrever `AGENDAMENTO`; OK aos moves de
A3/F2; janela de sync = 14 dias.

**Roadmap pós-flip:** liberar escrita CNN (ativa A1/W1, W2, A2); configurar webhooks no Kommo; refresh
OAuth do token Kommo (`KOMMO_CLIENT_SECRET`); Função 3 (orçamento); etapa "Importado CNN"; Função 4
(reconciliação de campos); sufixo `(duplicata)`; limpeza dos `/debug-*`.

---

## APÊNDICE — Cronologia das versões deployadas (Version IDs)
Sequência de deploys durante o trabalho (mais recentes ao fim):
`66a6233b` (Fase 1) → `887c58c0` (/debug-count) → `35d774de` (count corrigido) → `64434a38` (Fase 3) →
`b686b60a` (Fase 4) → `7b52aee2` (orçamento A3) → `819e15b5` (E2E scaffolding) → `c3ef26bd` (/debug-move) →
`6d2d5980` (/debug-agendas) → `9e4b3aba` (filtro interno + retry nome) → `5444934f` (map+skipnames) →
`f6d43de2` (fila: schema+produtor+consumidor+tick) → `6391a3ed` (produtor otimizado) →
`52a83fa1` (consumidor com leadId+auditoria) → `2fe7b3d5` (/debug-audit) → `32520af8` (A3/F2 na fila).

## APÊNDICE — Números-chave medidos
- Leads Kommo produção: **2.451** (Captação 2.450, Pós-Venda 1, Pós-Consulta 0).
- Teto sub-requests free: **50/invocação** (D1 não conta; provado).
- Agendas janela 90d: **639** (7 páginas, CNN capa 100/pág).
- Agendas/dia útil: **45-56**; domingo: **0**.
- Custo por item da fila: vincular ~1 fetch, criar ~3 fetch.
- Produtor: 102s → **13s** após otimização (1 query + DB.batch).
- Backfill: **350 mapeados, 52 criados (20 A / 32 B), 298 vinculados, 0 erros**.
- Consumo por tick: **10-18 sub-requests** (folgado sob 50).

---
*Fim do diário técnico.*
