# Fase 2 — Backfill seletivo (item 4) — Plano de Implementação

> **Para workers agênticos:** SUB-SKILL: superpowers:subagent-driven-development ou executing-plans. Passos com checkbox.

**Goal:** Backfill 1× que cria card **"Cliente Ativo" (Pós-Venda)** só para pacientes com **agendamento FUTURO ativo de Grupo B**; pula quem só tem Grupo A. Rollout escalonado por janela (3 → 7 → 14 → 28 → 56 → 90 → 180 dias), conferindo erros entre etapas.

**Architecture:** Usa a **via direta** `backfillCadastros` (endpoint `/debug-a4`), que cria cards diretamente e **NÃO usa a fila** — escolha deliberada: como o cron da Fase 1 já drena a fila a cada minuto com escrita real, um enqueue "dry" seria consumido pelo cron. A via direta tem `dry=1` seguro (não escreve, não enfileira). Lê CNN de produção (só leitura) e escreve só no Kommo.

**Tech Stack:** TypeScript, Cloudflare Worker, D1, `wrangler`. Validação: `tsc` + `/debug-a4?dry=1` + `/debug-audit`.

## Global Constraints

- **§7.8:** backfill NÃO escreve no CNN (só `cnnGet` leitura + `kommoPost`/`kommoPatch`). `target="production"` lê o CNN real.
- **Seletividade (item 4):** só **Grupo B** (`grupoDaAgenda === "B"`); **futuro** (`ini = hoje BRT`, sem lookback); **ativo** (pula `STATUS_TERMINAL`). Pacientes só-Grupo-A → não cria.
- **Idempotência:** anti-ressurreição por `mapeamento` (paciente já com lead nunca recria); dedup por telefone (`phoneKey`); `ANO_PISO=2026`.
- **Staging:** janelas 3→7→14→28→56→90→180; `dry=1` antes de `dry=0` em cada; conferir `/debug-audit` entre etapas.
- **Pré-requisito:** só executar (Task 4) **depois da Fase 1 confirmada estável** (baseline drenado + confirmação das 15h verificada).
- **Sem git:** sem commits; rollback = redeploy do Version ID anterior.
- **Deploy:** `npx wrangler deploy src/index.ts` (token CF com IP já liberado).

---

### Task 1: Tornar o backfill seletivo (só Grupo B, futuro, ativo)

Aplicar a MESMA regra em `backfillCadastros` (via direta, usada) e `produtorBackfill` (via fila, por consistência/segurança).

**Files:** Modify `src/index.ts`

- [ ] **Step 1 — `backfillCadastros`: janela só futuro.** Substituir (linha ~888):

```ts
  const ini = new Date(Date.now() - 3 * 3600 * 1000 - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
```
por:
```ts
  const ini = todayBRT(); // backfill = só futuro (não varre passado)
```

- [ ] **Step 2 — `backfillCadastros`: filtro Grupo B + ativo.** Substituir o bloco (linhas ~906-913):

```ts
  out.pulados_interno = 0;
  const comGrupo: Array<{ a: any; g: "A" | "B" }> = [];
  for (const a of todas) {
    if (isTarefaInterna(a)) { out.pulados_interno++; continue; }
    const g = grupoDaAgenda(a, tiposMap);
    if (!g) { out.pulados_tipo++; continue; }
    comGrupo.push({ a, g });
  }
```
por:
```ts
  out.pulados_interno = 0; out.pulados_status = 0; out.pulados_grupoA = 0;
  const comGrupo: Array<{ a: any; g: "A" | "B" }> = [];
  for (const a of todas) {
    if (isTarefaInterna(a)) { out.pulados_interno++; continue; }
    if (STATUS_TERMINAL.has(a.status ?? "")) { out.pulados_status++; continue; } // só agenda ativa
    const g = grupoDaAgenda(a, tiposMap);
    if (!g) { out.pulados_tipo++; continue; }
    if (g !== "B") { out.pulados_grupoA++; continue; } // só Grupo B → Cliente Ativo
    comGrupo.push({ a, g });
  }
```

- [ ] **Step 3 — `produtorBackfill`: janela só futuro.** Substituir (linha ~1001):

```ts
  const ini = new Date(Date.now() - 3 * 3600 * 1000 - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
```
por:
```ts
  const ini = todayBRT(); // backfill = só futuro
```

- [ ] **Step 4 — `produtorBackfill`: filtro Grupo B + ativo.** Substituir o bloco (linhas ~1017-1032):

```ts
  const porPaciente = new Map<string, { grupo: "A" | "B"; agenda: any; telefone: string }>();
  for (const a of todas) {
    if (isTarefaInterna(a)) { out.pulados_interno++; continue; }
    const g = grupoDaAgenda(a, tiposMap);
    if (!g) { out.pulados_tipo++; continue; }
    const ano = Number((a.data ?? "").slice(0, 4));
    if (ano && ano < ANO_PISO) { out.pulados_ano++; continue; }
    const pid = String(a.idPaciente ?? "");
    const tel = normalizePhone(a.telefoneCelularPaciente ?? "");
    if (!pid || tel.length < 8) continue;
    if (soTeste && !isTestePhone(tel)) continue;
    const existe = porPaciente.get(pid);
    // B vence A; entre iguais, mantém o primeiro
    if (!existe || (existe.grupo === "A" && g === "B")) porPaciente.set(pid, { grupo: g, agenda: a, telefone: tel });
  }
```
por:
```ts
  out.pulados_status = 0; out.pulados_grupoA = 0;
  const porPaciente = new Map<string, { grupo: "A" | "B"; agenda: any; telefone: string }>();
  for (const a of todas) {
    if (isTarefaInterna(a)) { out.pulados_interno++; continue; }
    if (STATUS_TERMINAL.has(a.status ?? "")) { out.pulados_status++; continue; } // só agenda ativa
    const g = grupoDaAgenda(a, tiposMap);
    if (!g) { out.pulados_tipo++; continue; }
    if (g !== "B") { out.pulados_grupoA++; continue; } // só Grupo B → Cliente Ativo
    const ano = Number((a.data ?? "").slice(0, 4));
    if (ano && ano < ANO_PISO) { out.pulados_ano++; continue; }
    const pid = String(a.idPaciente ?? "");
    const tel = normalizePhone(a.telefoneCelularPaciente ?? "");
    if (!pid || tel.length < 8) continue;
    if (soTeste && !isTestePhone(tel)) continue;
    if (!porPaciente.has(pid)) porPaciente.set(pid, { grupo: "B", agenda: a, telefone: tel });
  }
```

- [ ] **Step 5 — Compilar.** Run: `cd D:\clarissa-bergmann\kommo-cnn; npx tsc --noEmit` → sem novos erros (só os 6 pré-existentes). Conferir que `STATUS_TERMINAL` resolve (é const de módulo, definida adiante — ok em runtime).

---

### Task 2: Expor `window` no endpoint `/debug-a4` (para staging)

**Files:** Modify `src/index.ts` (handler `/debug-a4`, ~linhas 2177-2185)

- [ ] **Step 1 — Substituir o handler:**

```ts
    if (pathname === "/debug-a4") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const u = new URL(req.url);
      const dry = u.searchParams.get("dry") !== "0";
      const soTeste = u.searchParams.get("soteste") !== "0";
      const target: CnnTarget = u.searchParams.get("env") === "production" ? "production" : "sandbox";
      const max = Number(u.searchParams.get("max") ?? "40");
      return Response.json(await backfillCadastros(env, dry, soTeste, target, max));
    }
```
por:
```ts
    if (pathname === "/debug-a4") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      const u = new URL(req.url);
      const dry = u.searchParams.get("dry") !== "0";
      const soTeste = u.searchParams.get("soteste") !== "0";
      const target: CnnTarget = u.searchParams.get("env") === "production" ? "production" : "sandbox";
      const max = Number(u.searchParams.get("max") ?? "40");
      const windowDays = Number(u.searchParams.get("window") ?? "90");
      return Response.json(await backfillCadastros(env, dry, soTeste, target, max, windowDays));
    }
```

- [ ] **Step 2 — Compilar.** `npx tsc --noEmit` → sem novos erros.

---

### Task 3: Deploy das mudanças do backfill (GATE: Fase 1 estável + OK do dono)

- [ ] **Step 1 — Deploy.** `cd D:\clarissa-bergmann\kommo-cnn; $env:CLOUDFLARE_API_TOKEN="<token>"; npx wrangler deploy src/index.ts` → anotar Version ID. (Não muda o cron da Fase 1; só `backfillCadastros`/`produtorBackfill`/handler.)

---

### Task 4: Execução escalonada do backfill (GATE por etapa)

Via `/debug-a4` (via direta, sem fila). `SECRET` = `WEBHOOK_SECRET`. Base = `https://kommo-cnn.clarissabergmann03.workers.dev`.

Para cada janela `N` em **3 → 7 → 14 → 28 → 56 → 90 → 180**:

- [ ] **Step A — Preview (dry).**
```bash
curl -sS -H "Authorization: $SECRET" \
  "https://kommo-cnn.clarissabergmann03.workers.dev/debug-a4?dry=1&soteste=0&window=N&env=production&max=40"
```
Conferir: `criar[]` (quem viraria card B / Cliente Ativo), `vinculados`, `pulados_grupoA` (>0 = Grupo A sendo corretamente ignorado), `pulados_status`, 0 erros. **Conferir a lista com o dono.**

- [ ] **Step B — Executar (real), repetindo até `sweep_completo=true`.**
```bash
curl -sS -H "Authorization: $SECRET" \
  "https://kommo-cnn.clarissabergmann03.workers.dev/debug-a4?dry=0&soteste=0&window=N&env=production&max=40"
```
`backfillCadastros` processa um lote por chamada (cursor/offset, para no `budget`). Repetir a MESMA chamada até a resposta trazer `sweep_completo: true`. Entre chamadas, conferir `criados`/`vinculados`/erros.

- [ ] **Step C — Verificar.** `GET /debug-audit` → novos `A4 card-criado` para B; conferir no Kommo (Pós-Venda / Cliente Ativo); 0 erros. Só então avançar para o próximo `N`.

**Idempotência entre janelas:** janela maior re-varre, mas anti-ressurreição (`mapeamento`) pula quem já virou card → só adiciona os novos. Sem duplicados.

---

## Riscos / observações
- **Cria cards reais** (Kommo produção) para pacientes reais quando `soteste=0` — por isso staged + dry-first + conferência por etapa.
- A via direta (`backfillCadastros`) **não interage com a fila/cron**; cards criados são baselined (`upsertAgendaSync`) → o sync da Fase 1 não os duplica.
- `produtorBackfill` (via fila) também foi tornado seletivo (Task 1) por segurança, mas a execução oficial é pela via direta.
- Se um lote der erro de Kommo (rate limit), o cursor permite retomar; conferir `/debug-audit` por itens com erro.
