# Metodologia de Testes — Reflexo de Orçamento (antes de produção)

**Objetivo:** provar que a feature **não quebra em produção** antes de ligar. Testes em **níveis** (do determinístico/isolado ao real/ao vivo), com **stress test**, executados por **subagentes**. Nada vai pra produção sem passar N0–N6; N7 é rollout gated.

**Restrições do ambiente:** Worker single-file, sem framework de teste. Vetores usados:
- **`wrangler dev --local`** — roda o código localmente, SEM secrets/edge → para lógica pura + fuzz + stress (mock). Rápido, determinístico, isolado. NÃO é deploy.
- **`wrangler dev --remote`** — roda o código local na edge com secrets REAIS → integração de leitura + dry-run + write-path controlado. NÃO é deploy em produção (não altera o Worker `kommo-cnn` no ar).
- **Endpoint de teste `/debug-selftest`** (a construir) — bateria de asserções in-code (modes: `logic` | `fuzz` | `stress`), sem tocar CNN/Kommo/D1 real.
- Fixtures: TESTE Bruno (Paciente CNN `28146949`, tel `11946800329`).
- Rollback sempre pronto: version `b0167bfa` / `ORC_ENABLED=false`.

**Critério global de PASS:** um nível só é "verde" com evidência (saída do comando/endpoint anexada ao relatório). Falhou → corrige → re-testa o nível. Nenhum nível pulado.

---

## N0 — Estático (FEITO ✅)
- `tsc --noEmit`: só os 5 erros baseline, 0 novos.
- Review whole-branch (opus) + re-review do fix C1: resolvem C1, read-only, additive, sem mexer em A3/F2/sync bodies.

## N1 — Lógica pura (determinístico) — `/debug-selftest?mode=logic` via `dev --local`
Bateria de asserções sobre as funções puras (testa o CÓDIGO REAL, sem drift):
- `decidirEtapaOrcamento`: **matriz completa** — `[]`→null; `[ABERTO]`→Em Análise; `[CANCELADO]`/`[PERDIDO]`→Venda Perdida; `[APROVADO]`→Tratamento Iniciado; `[ABERTO,APROVADO]`→Tratamento Iniciado (aprovado vence recência); `[ABERTO(id=9),CANCELADO(id=10)]`→Venda Perdida (mais recente por id); `temFutura=true` em qualquer combo → null (portão).
- Portão de etapa `ETAPAS_ORC_PODE_AGIR`: cada etapa conhecida → age (Avaliação/Tratamento Proposto/3 do ORC) vs adia (Leads/Primeiro Contato/Agendada/Confirmação/Confirmada/Cliente Ativo/Confirmação Agend).
- Expiração: `idadeSeg > 1200` → giveup; `<=1200` → adiado.
- Cursor: `addDiasISO` soma certo; reset ao passar de hoje; lookback 730d.
- Chave dedup: formato `ORC:pid:YYYY-MM-DD`.
**PASS:** 100% asserts verdes.

## N2 — Fuzz / adversarial (resiliência a input ruim) — `/debug-selftest?mode=fuzz` via `dev --local`
Inputs degenerados nas funções que consomem payload CNN: lista vazia; orçamento sem `id`; `id` não-numérico (`"abc"`); `status` desconhecido / minúsculo (`"aprovado"`) / `null` / faltando; `paciente` undefined; `contato` undefined (sem telefone); procedimentos/produtos undefined; lista com 5.000 itens.
**PASS:** nenhuma exceção; degradação graciosa (null/valor seguro); status minúsculo NÃO conta como APROVADO (case-sensitive — confirmar se é o desejado, senão flag).

## N3 — Stress da fila + budget (mock, sem D1/CNN real) — `/debug-selftest?mode=stress&n=…` via `dev --local`
Simula produtor→fila→consumidor com fila mock em memória + CNN mock. Escalas `n = 10, 100, 1000` pacientes, mistura de estados (com % em etapa não-assentada → gera `adiado`):
- **INV1 budget:** contador de subreq simulado nunca passa de 50/invocação.
- **INV2 anti-starvation:** em cada dreno, todos os A3/F2 pendentes são puxados antes de qualquer ORC (ordem bucket).
- **INV3 adiado bounded:** itens adiados expiram (~20min simulados) → viram feito; não crescem indefinidamente.
- **INV4 anti-deadlock:** com A3-FINALIZADO + ORC-adiado do mesmo paciente, o A3 dreno abre o portão e o ORC resolve (não trava).
- **INV5 idempotência:** rodar o consumidor 2× no mesmo estado → 0 move duplicado (orcamento_sync mock).
**PASS:** todas as invariantes em todas as escalas.

## N4 — Integração leitura real (dev-remote, SEM deploy) — `/debug-orcamento`
`wrangler dev --remote` → `/debug-orcamento?env=production&status=APROVADO|ABERTO|CANCELADO`.
Confirma o SHAPE real (resolve os "cannot-verify"): `id` numérico e crescente com criação; `paciente.id`; `paciente.contato.telefoneCelular`; `status` UPPERCASE exato. Mede **volume** por status (dimensiona o rollout).
**PASS:** shape confirmado (ou ajuste do código se divergir) + volume medido.

## N5 — Dry-run do fluxo real (dev-remote) — `/debug-tick?job=orcamento&dry=1&prod=1`
Varre a base real, mostra o que MOVERIA (0 escrita). Spot-check: amostra de decisões bate com `decidirEtapaOrcamento`? Quantos `adiado` (esperando consulta assentar)? Budget < 50? 0 erro no sweep inteiro?
**PASS:** decisões corretas na amostra, 0 erro, budget OK, contagem de moves plausível vs N4.

## N6 — Write-path controlado (dev-remote, TESTE Bruno) — consumidor real
Cenários no TESTE Bruno (montar etapa + orçamento simulado no sandbox onde possível; senão validar o mecanismo de move+reverter):
- Avaliação Realizada + `APROVADO` → Tratamento Iniciado; audit ORC gravado; orcamento_sync atualizado.
- Rodar 2× → 2ª vez `sem_mudanca` (idempotência).
- Lead em "Consulta Confirmada" + `APROVADO` → `adiado` (portão fecha).
- Lead em "Perdido" + `APROVADO` → Tratamento Iniciado (Finding A / reativação).
- **Reverter tudo** (padrão limpar-após-teste).
**PASS:** todos os cenários corretos + revertidos + fila limpa.

## N7 — Rollout escalonado (PRODUÇÃO, GATED por OK) 
1. Deploy INERTE (`ORC_ENABLED=false`) → confirmar `SELECT status,COUNT(*) FROM fila_trabalho WHERE tipo='ORC'` = vazio.
2. Flip `ORC_ENABLED=true` → observar 1–2 ticks no `/debug-audit` (funcao ORC).
3. Expandir gradualmente (cap/observação) conferindo entre etapas: moves corretos, **0 erro**, **0 conflito com A3/F2** (nenhum lead pingue-pongando), subreq/invocação dentro do teto.
Rollback a qualquer sinal: `ORC_ENABLED=false` (redeploy) ou version `b0167bfa`.
**PASS:** feature ativa e saudável ao vivo.

---

## Execução por subagentes
- **S1 (build):** cria `/debug-selftest` (modes logic|fuzz|stress) + auditoria "adiado-expirado" (Finding B). `tsc` limpo.
- **S2 (N1–N3):** roda `dev --local` + curl selftest nos 3 modes; relatório com saídas.
- **S3 (N4–N5):** roda `dev --remote` + `/debug-orcamento` + `/debug-tick dry`; relatório (shape, volume, dry).
- **S4 (N6):** write-path no TESTE Bruno + reverter; relatório.
- Controlador: revisa cada relatório; N7 só com OK do dono.
