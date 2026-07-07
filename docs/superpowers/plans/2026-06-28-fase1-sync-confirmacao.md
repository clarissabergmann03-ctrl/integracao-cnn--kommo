# Fase 1 — Sync de base (CNN→Kommo) + Confirmação por horário — Plano de Implementação

> **Para workers agênticos:** SUB-SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para executar tarefa a tarefa. Os passos usam checkbox (`- [ ]`).

**Goal:** Ligar em produção a camada de fila já existente para (item 3) sincronizar CNN→Kommo na janela −2/+14 a cada minuto e (item 1) confirmar agendamentos por horário (Seg–Sex 15h→D+1; Sáb 11h→segunda), aposentando os crons legados C1/C2.

**Architecture:** O `scheduled()` vira o dispatcher: a cada minuto reseta o orçamento de sub-requests, roda os produtores no horário certo (véspera por dia-da-semana; sync a cada 10 min) e sempre drena a fila com `consumirFila`. Produtores leem o CNN de **produção** (só leitura) e os consumidores escrevem **só no Kommo**. Não há `cnnPost`/`cnnPut` nesta fase → a §7.8 não é tocada.

**Tech Stack:** TypeScript, Cloudflare Workers (`scheduled` + `fetch`), D1, `wrangler`. Sem suíte de testes automatizada → validação por `tsc` + dry-run nos endpoints `/debug-*` + monitoramento via `/debug-audit` e Kommo.

## Global Constraints

- **§7.8 (CNN prod = só leitura):** nenhuma chamada `cnnPost`/`cnnPut` nesta fase. Produtores usam `cnnGet(..., target)`; consumidores escrevem só no Kommo. `target = "production"` no cron (lê CNN real, escreve Kommo real).
- **Plano free:** teto 50 `fetch`/invocação. `resetSubreq()` no início de CADA tick. `consumirFila` com `budget = 40`, `cap = 10`. D1 não conta no teto.
- **Fuso:** regras de negócio em BRT (UTC−3); crons declarados em UTC. 15h BRT = 18h UTC; 11h BRT = 14h UTC (não cruzam meia-noite → dia-da-semana UTC == dia-da-semana BRT nesses horários).
- **Idempotência:** preservar `lembrete_d1` (1 confirmação por lead/dia) e `agenda_sync` (baseline anti-eco). Primeira passada do sync = baseline em massa (não move etapa).
- **Cancelamento (já no `MAPA_STATUS`):** Grupo A → "Cancelada–Perdido"; Grupo B → "Cliente Ativo". Não alterar.
- **Sem git:** o projeto não é repositório git → sem `git commit`. "Checkpoint" = `tsc` passa; ponto de rollback = Version ID do `wrangler deploy`.
- **Deploy:** `npx wrangler deploy src/index.ts` com `CLOUDFLARE_API_TOKEN`. Risco conhecido: token pode ser recusado por restrição de IP (`code 9109`) — ver Riscos.
- **Auth dos `/debug-*`:** header `Authorization: $SECRET`, onde `$SECRET` = `WEBHOOK_SECRET` do Worker. Não escrever o valor literal em arquivos.

---

### Task 1: Helper `nextMondayBRT()`

Necessário para a confirmação de sábado (11h) mirar a **segunda** (D+2). Hoje só existe `tomorrowBRT()`; **não há** helper de dia-da-semana.

**Files:**
- Modify: `src/index.ts` (inserir logo após `todayBRT()`, ~linha 290)

**Interfaces:**
- Produz: `function nextMondayBRT(): string` — data ISO `YYYY-MM-DD` da próxima segunda-feira em BRT.

- [ ] **Step 1: Inserir o helper** após a função `todayBRT()`:

```ts
// Próxima segunda-feira em BRT (confirmação de sábado → segunda).
function nextMondayBRT(): string {
  const d = new Date(Date.now() - 3 * 3600 * 1000); // "agora" em BRT
  const day = d.getUTCDay();                          // 0=Dom .. 6=Sáb (já deslocado p/ BRT)
  const ate = ((1 - day) + 7) % 7 || 7;              // dias até a próxima segunda (nunca 0)
  d.setUTCDate(d.getUTCDate() + ate);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 2: Compilar**

Run: `cd D:/clarissa-bergmann/kommo-cnn && npx tsc --noEmit`
Expected: sem novos erros (podem persistir os ~2 avisos pré-existentes já documentados).

---

### Task 2: Reescrever `scheduled()` como o dispatcher da fila (o "flip")

**Files:**
- Modify: `src/index.ts:2575-2580` (handler `scheduled`)

**Interfaces:**
- Consome: `resetSubreq()`, `produtorVespera(env, target, dataAlvo?)`, `produtorSync(env, target, windowDays)`, `consumirFila(env, target, dryRun, cap, budget)`, `tomorrowBRT()`, `nextMondayBRT()` (Task 1), tipo `CnnTarget`.
- Produz: nada (handler terminal).

- [ ] **Step 1: Substituir o handler** atual:

```ts
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      if (event.cron === "0 18 * * *") await cronLembreteD1(env);
      else                             await cronSyncStatus(env);
    })());
  },
```

por:

```ts
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      resetSubreq();                              // teto de 50 fetch/invocação é por invocação
      const target: CnnTarget = "production";     // Fase 1: lê CNN prod (só leitura) + escreve Kommo
      const t = new Date(event.scheduledTime);
      const day = t.getUTCDay();                  // 0=Dom..6=Sáb (válido p/ 18h/14h UTC = mesmo dia BRT)
      const hour = t.getUTCHours();
      const min = t.getUTCMinutes();
      try {
        // Item 1 — Confirmação por horário (enfileira; o dreno abaixo move o lead)
        if (day >= 1 && day <= 5 && hour === 18 && min === 0) {
          await produtorVespera(env, target, tomorrowBRT());     // Seg–Sex 15h BRT → D+1
        } else if (day === 6 && hour === 14 && min === 0) {
          await produtorVespera(env, target, nextMondayBRT());   // Sáb 11h BRT → segunda
        }
        // Item 3 — Sync de base CNN→Kommo (janela −2/+14, produtor a cada 10 min)
        if (min % 10 === 0) {
          await produtorSync(env, target, 14);                   // windowDays=14 ⇒ −2/+14
        }
        // Dreno da fila todo minuto (escreve Kommo; nunca CNN)
        await consumirFila(env, target, false, 10, 40);
      } catch (e) {
        // Não derruba o tick; erros de item já são tratados em consumirFila/auditoria.
      }
    })());
  },
```

Notas: C1/C2 (`cronLembreteD1`/`cronSyncStatus`) deixam de ser chamados (funções permanecem no arquivo, viram código inerte). `produtorVespera`/`produtorSync` enfileiram em D1; `consumirItemF2` move p/ "Confirmação de Consulta" (A) / "Confirmação de Agendamento" (B); `consumirItemA3` faz baseline na 1ª vez e depois reflete status/hora.

- [ ] **Step 2: Compilar**

Run: `cd D:/clarissa-bergmann/kommo-cnn && npx tsc --noEmit`
Expected: sem novos erros.

---

### Task 3: Trocar os crons no `wrangler.toml`

**Files:**
- Modify: `wrangler.toml` (bloco `[triggers]`)

- [ ] **Step 1: Substituir** o bloco:

```toml
[triggers]
# C1: 15h BRT = 18h UTC — lembrete D-1
# C2: a cada 10 minutos — sync CNN↔Kommo
crons = ["0 18 * * *", "*/10 * * * *"]
```

por:

```toml
[triggers]
# Dispatcher único: a cada minuto reseta orçamento, roda produtores no horário
# (confirmação Seg–Sex 18h UTC / Sáb 14h UTC; sync a cada 10 min) e drena a fila.
crons = ["* * * * *"]
```

- [ ] **Step 2: Validar bundle + config (sem deploy)**

Run: `cd D:/clarissa-bergmann/kommo-cnn && $env:CLOUDFLARE_API_TOKEN="<token>"; npx wrangler deploy src/index.ts --dry-run`
Expected: build OK, lista 1 cron trigger `* * * * *`, **não** publica.

---

### Task 4: Validação comportamental em dry-run contra produção (leitura) — ANTES do deploy

Os produtores/consumidores não mudaram; só passaram a ser chamados pelo `scheduled()`. Valida-se o COMPORTAMENTO via `/debug-tick` no Worker **já publicado** (não depende das Tasks 1–3). `dry=1` ⇒ `consumirFila` não escreve no Kommo.

> `SECRET` = `WEBHOOK_SECRET`. Base = `https://kommo-cnn.clarissabergmann03.workers.dev`.

- [ ] **Step 1: Sync (item 3) em dry** — limpa fila, roda produtor (janela 14 = −2/+14), dry-consome até 30:

Run:
```bash
curl -sS -H "Authorization: $SECRET" \
  "https://kommo-cnn.clarissabergmann03.workers.dev/debug-tick?env=production&dry=1&prod=1&job=sync&window=14&cap=30&clear=1"
```
Expected: `out.produtor.agendas` > 0; a maioria dos itens em `out.consumidor.itens[].r` = `"baseline"` (1ª passada); `out.subreq_total` < 50; `out.consumidor.erros` = 0. **Conferir** que `nao_mapeado` é pequeno (agendas sem lead vão pro item 4, não aqui).

- [ ] **Step 2: Confirmação (item 1) em dry** — para o próximo dia-alvo útil (ex.: amanhã se hoje é Seg–Sex):

Run:
```bash
curl -sS -H "Authorization: $SECRET" \
  "https://kommo-cnn.clarissabergmann03.workers.dev/debug-tick?env=production&dry=1&prod=1&job=vespera&data=AAAA-MM-DD&cap=50&clear=1"
```
Expected: `out.consumidor.itens[]` lista os leads que **seriam** movidos p/ confirmação (todos `r:"movido"` em dry), roteados por grupo. **Conferir a lista com o dono** antes do deploy (são moves reais que dispararão WhatsApp depois).

- [ ] **Step 3: Limpar a fila antes do deploy** (o dry deixou itens `pendente`):

Run:
```bash
curl -sS -H "Authorization: $SECRET" \
  "https://kommo-cnn.clarissabergmann03.workers.dev/debug-tick?env=production&dry=1&cap=0&clear=1"
```
Expected: `out.fila` sem `pendente` (ou ausente). O 1º `produtorSync` pós-deploy re-enfileira o estado atual.

---

### Task 5: Deploy do flip + monitoramento (GATE: OK explícito do dono)

- [ ] **Step 1: Deploy**

Run: `cd D:/clarissa-bergmann/kommo-cnn && $env:CLOUDFLARE_API_TOKEN="<token>"; npx wrangler deploy src/index.ts`
Expected: publica; anotar o **Version ID** (ponto de rollback). Se falhar com `code 9109` (IP), ver Riscos.

- [ ] **Step 2: Monitorar a 1ª passada (baseline, ~15 min)**

Run (após ~15 min):
```bash
curl -sS -H "Authorization: $SECRET" \
  "https://kommo-cnn.clarissabergmann03.workers.dev/debug-audit"
```
Expected: `por_acao` **sem** enxurrada de `etapa-movida` (a 1ª passada é baseline). `fila` drenando (pendente → 0). Conferir no Kommo que **não houve** movimentação em massa.

- [ ] **Step 3: Conferir a 1ª confirmação real**

No próximo gatilho (Seg–Sex 18:00 UTC ou Sáb 14:00 UTC), após alguns minutos:
```bash
curl -sS -H "Authorization: $SECRET" \
  "https://kommo-cnn.clarissabergmann03.workers.dev/debug-audit"
```
Expected: `por_acao` com `F2 / vespera-move` para os leads do dia-alvo; conferir no Kommo que os leads de amanhã (ou de segunda, se sábado) entraram em "Confirmação de Consulta"/"Confirmação de Agendamento" e que o WhatsApp disparou.

- [ ] **Step 4 (se necessário): Rollback**

Reverter `scheduled()` (Task 2) e `wrangler.toml` (Task 3) ao estado anterior e `npx wrangler deploy src/index.ts` — volta a C1/C2 em ~30s. Alternativa: `npx wrangler rollback` para o Version ID anterior.

---

## Riscos / observações

- **Deploy bloqueado por IP (`code 9109`):** já ocorreu neste projeto. Mitigação: fixar `CLOUDFLARE_ACCOUNT_ID`/usar token sem restrição de IP, ou deployar de IP autorizado.
- **1ª passada de sync = baseline:** esperado não mover etas em massa; se aparecer movimentação grande, pausar (rollback) e investigar `agenda_sync`.
- **Confirmação dispara WhatsApp real:** por isso o Step 2 da Task 4 exige conferência da lista com o dono antes do deploy.
- **`target="production"` lê o CNN real:** é leitura (`cnnGet`), permitida pela §7.8. Nenhum `cnnPost/cnnPut` nesta fase (confirma-se por inspeção: consumidores só usam Kommo/D1).
- **Orçamento:** nos minutos múltiplos de 10 rodam produtor(es) + dreno no mesmo tick; soma estimada < 50 subreq (produtores ~2–4 de paginação; consumidor para em `budget=40`).
