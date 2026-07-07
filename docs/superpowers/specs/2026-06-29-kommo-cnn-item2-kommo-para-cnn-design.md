# Design — Item 2: Kommo→CNN (criação W1 + reconciliação de status)

**Data:** 2026-06-29
**Status:** Design aprovado em brainstorming — aguardando review do spec antes do plano.
**Projeto:** `kommo-cnn`. Fonte da verdade do código: `src/index.ts`.
**Ordem:** fase **depois** da regra de duplicata (CNN→Kommo). "Ambos, em ordem."

---

## 1. Contexto

Hoje o fluxo em produção é **mão única CNN→Kommo** (Fase 1). Este item adiciona a direção **Kommo→CNN** (torna semi-bilateral). **Escreve no CNN** → por isso é **desenvolvido/validado no sandbox primeiro** e só vai pra produção depois (§7.8: a chave de produção do CNN é só-leitura até liberação explícita; a trava `assertCnnWritable` permanece até o gate de liberação).

## 2. Escopo (3 peças, todas escrevem CNN)

1. **W1 — criação** (`handleLeadAgendado`, webhook `lead-agendado`): lead movido pra "Consulta Agendada" → cria paciente (se não existe) + agendamento no CNN; grava `ID Agenda CNN`/`ID Paciente CNN` no lead.
2. **W2 — confirmação** (`handleConfirmacao`, webhook): paciente confirma no WhatsApp → CNN `PUT /agenda/alteracao-status {CONFIRMADO_PACIENTE}` + move lead pra "Consulta Confirmada".
3. **Reconciliação por polling** (rede de segurança do webhook): varre leads em **"Consulta Confirmada"** → CNN `CONFIRMADO_PACIENTE`; em **"Avaliação Realizada"** → CNN `FINALIZADO`; **só escreve se o status no CNN ainda diverge** (idempotente).

## 3. W1 — campos de criação (resolve a pendência P4)

O lead do Kommo não carrega tipo de consulta nem profissional. **Decisão (29/06):** a secretária preenche esses campos no card; o W1 lê e mapeia pro CNN.

- **Custom fields novos no Kommo** (criados via API `POST /leads/custom_fields` — passo de setup): **"Tipo Consulta CNN"** e **"Profissional CNN"** (select). Idealmente as opções do select são populadas a partir do CNN (`GET /tipo-consulta/lista` e `GET /executor-agenda/lista`).
- **Mapeamento valor→ID CNN:** o W1 resolve o nome selecionado pro ID do CNN — tipo via `resolveTiposConsulta` (já existe, por nome normalizado); profissional via `/executor-agenda/lista` (novo resolver, com cache análogo). Convênio = Particular (`getOrCreateConvenioParticular`, já existe). Local = default (`CNN_LOCAL_AGENDA`). Hora-fim = início + 30 min. Data/hora = campo `AGENDAMENTO`.
- **Validação:** se faltar tipo ou profissional no card → W1 não cria; registra pendência/erro (não inventa). (Os campos obrigatórios do CNN que faltarem têm origem definida: tipo e profissional vêm do card; convênio/local/hora têm default.)

## 4. Reconciliação (polling) + interação com a duplicata

- Roda no cron (junto do tick). Varre as etapas Kommo "Consulta Confirmada" e "Avaliação Realizada".
- Para cada card, acha a **agenda do grupo correspondente** (via `ID Agenda CNN` do card / mapeamento `(paciente, grupo)`): o card de **Captação (A)** → agenda A; o card de **Pós-Venda (B)** → agenda B. Empurra o status só se diverge.
- Com a **duplicata** (2 cards), cada card reconcilia a SUA agenda — sem cruzar (o A confirma a agenda A; o B, a agenda B).

## 5. Supressão de eco / anti-loop

- Toda escrita Kommo→CNN deve **atualizar o baseline `agenda_sync`** (`last_cnn_status`/`last_agendamento_ts`) imediatamente, pra que o próximo ciclo CNN→Kommo veja o estado já reconciliado e **não rebata** (não mova o lead de novo).
- Idempotência: W1 pula se o lead já tem `ID Agenda CNN` (`already_synced`); reconciliação só escreve se o status diverge; W2 idem.

## 6. Rollout (§7.8 — sandbox → produção, com gate)

- Toda a peça é construída e validada no **sandbox** (allowlist de teste).
- Liberar produção é um **passo separado, com OK explícito do dono**: só então `assertCnnWritable` é afrouxado para os caminhos de escrita aprovados (`/agenda/novo`, `/agenda/alteracao-status`, `/paciente/novo`, `/convenio-paciente/associar`). Até lá, em produção, continua bloqueado.
- Antes de ligar em produção: configurar os webhooks no painel do Kommo (W1/W2) — o `lead-agendado` o dono confirmou estar configurado; o `confirmacao` (Salesbot) a confirmar.

## 7. Fora de escopo
- A regra de duplicata/anti-spam/mais-próximo (CNN→Kommo) — fase anterior (spec própria).
- Função 3 (mover por orçamento), etapa "Importado CNN", Função 4, refresh OAuth Kommo — roadmap.

## 8. Riscos / observações
- **Escreve no CNN de produção real** — por isso sandbox-first + gate + per-passo. Maior risco do projeto.
- **P4 depende de setup no Kommo** (custom fields + a secretária preenchê-los) — sem os campos, o W1 não cria.
- **Profissional/executor:** precisa do resolver `/executor-agenda/lista` e que os nomes batam (como o roteamento por nome dos tipos).
- **Eco/loop:** a escrita Kommo→CNN tem que atualizar o baseline na hora, senão o sync CNN→Kommo rebate.
- Webhooks precisam estar configurados no Kommo (fora do código).
