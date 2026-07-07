# SPEC — F1 (log durável de tick) + F2 (sumário por tick + backlog por tipo/idade)

Escopo: **só a parte durável/observável** (tabela `tick_log`, instrumentação no `scheduled()` dentro do lease B2, endpoint `/debug-tick-log`). **NÃO inclui alerta externo** (isso é `[DECISAO]` do dono — ver seção final). Nenhum arquivo foi editado; tudo abaixo é texto pronto para colar.

Arquivo único: `D:/clarissa-bergmann/kommo-cnn/src/index.ts`.

---

## 0. Checagem do teto de escrita D1 (pré-requisito do item)

- **Teto de sub-requests (50 fetch/invocação): D1 NÃO conta.** Confirmado por dois pontos do próprio código: comentário em `src/index.ts:51-53` (“D1 NÃO conta: 200 queries OK”) e o veredito de `/debug-d1cost` (`src/index.ts:4263-4265`). Portanto `INSERT` + `DELETE` de poda em `tick_log` somam **0** a `subreqUsados`. O `registrarTick` é “grátis” para o orçamento da invocação.
- **Limite diário de escrita D1 (Free = 100.000 rows written/dia):** cron 1/min = 1440 ticks/dia. Por tick: 1 `INSERT` (tabela + 1 índice `idx_tick_ts` ≈ 2 rows written) + 1 `DELETE` de poda (em regime, ~1 linha cai fora ≈ 2 rows written). ≈ **4 rows written/tick × 1440 ≈ 5.760/dia** — desprezível frente a 100k, e frente ao que fila/auditoria já escrevem. Sem risco.
- **Storage:** ~4.320 linhas em regime (retenção 3 dias), cada uma pequena → KBs. Desprezível.
- **Concorrência:** `registrarTick` roda **dentro do lease B2** (serializado com o `/debug-tick`), então nunca há dois `INSERT` de tick concorrentes.

Conclusão: seguro. Nenhuma mudança no contador de subreq nem no orçamento de fetch.

---

## 1. Schema — nova tabela `tick_log` (em `ensureSchema`, ~`src/index.ts:560-562`)

Adicionar dois `env.DB.prepare(...)` ao `batch`, **antes** do `]);` que fecha o batch (logo após o `CREATE TABLE ... orcamento_sync`).

DE:
```ts
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS orcamento_sync (
      paciente_id_cnn TEXT PRIMARY KEY, lead_id_kommo TEXT, ultimo_status TEXT, ultima_etapa INTEGER, updated_at INTEGER)`),
  ]);
```
PARA:
```ts
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS orcamento_sync (
      paciente_id_cnn TEXT PRIMARY KEY, lead_id_kommo TEXT, ultimo_status TEXT, ultima_etapa INTEGER, updated_at INTEGER)`),
    // F1: log durável de cada tick do cron (1 linha/tick). D1 NÃO conta no teto de 50 subreq.
    // Colunas escalares = health por SQL sem parse; `resumo` (JSON) = inspeção profunda.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tick_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ok INTEGER NOT NULL,
      ms INTEGER, subreq INTEGER, gatilhos TEXT,
      processados INTEGER, movidos INTEGER, criados_b INTEGER, adiados INTEGER, erros INTEGER, transitorios INTEGER,
      fila_pendente INTEGER, fila_erro INTEGER, erro TEXT, resumo TEXT)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_tick_ts ON tick_log(ts)`),
  ]);
```

Tabela nova → `CREATE IF NOT EXISTS` é não-destrutivo, **sem ALTER**, sem migração. `idx_tick_ts` acelera a poda por `ts` e não é estritamente necessário para o endpoint (que ordena por `id DESC`).

Semântica das colunas:
- `ts` (epoch s) = início do tick; `ok` = 1 sucesso / 0 exceção; `ms` = wall-clock do tick; `subreq` = `subreqUsados` ao final; `gatilhos` = CSV dos produtores que rodaram (`vespera-d1`/`vespera-seg`/`sync`/`orc`).
- Contadores do **consumidor** (`out` de `consumirFila`): `processados, movidos, criados_b, adiados, erros, transitorios`.
- Snapshot da fila no fim do tick: `fila_pendente, fila_erro` (backlog por status via `filaStats`).
- `erro` = mensagem truncada da exceção do tick (se `ok=0`); `resumo` = JSON `{gatilhos, prod, cons}` (cap 4000 chars) para debug.

---

## 2. Helper `registrarTick` + constante (inserir após `filaStats`, ~`src/index.ts:671`)

Colocar logo depois do fecho de `filaStats` (linha 671, antes do bloco “D1 helpers: Função 2”):

```ts
// ── F1: log durável de tick (tabela tick_log) ─────────────────────────────────
// 1 linha por tick do cron. D1 NÃO conta no teto de 50 sub-requests (só fetch conta) →
// INSERT + poda são "grátis" pro orçamento da invocação. Best-effort: NUNCA lança
// (igual audit()) — observabilidade jamais quebra o fluxo. Roda DENTRO do lease B2
// (serializado), então não há INSERTs de tick concorrentes.
const TICK_LOG_RETENCAO_DIAS = 3;   // ~1440 linhas/dia → poda mantém ~3 dias (~4320 linhas)
async function registrarTick(
  env: Env,
  t: { ts: number; ok: boolean; ms: number; subreq: number; gatilhos: string[]; cons: any; erro?: string; resumo: any }
): Promise<void> {
  try {
    const c = t.cons ?? {};
    const fila = await filaStats(env);   // snapshot backlog por status (1 query D1)
    await env.DB.prepare(
      `INSERT INTO tick_log
         (ts, ok, ms, subreq, gatilhos, processados, movidos, criados_b, adiados, erros, transitorios, fila_pendente, fila_erro, erro, resumo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      t.ts, t.ok ? 1 : 0, t.ms, t.subreq, t.gatilhos.join(","),
      c.processados ?? 0, c.movidos ?? 0, c.criados_b ?? 0, c.adiados ?? 0, c.erros ?? 0, c.transitorios ?? 0,
      fila.pendente ?? 0, fila.erro ?? 0,
      t.erro ? t.erro.slice(0, 500) : null,
      JSON.stringify(t.resumo ?? {}).slice(0, 4000)
    ).run();
    // Poda: remove ticks além da retenção. DELETE barato (idx_tick_ts). Também "grátis" (D1 não conta subreq).
    await env.DB.prepare(`DELETE FROM tick_log WHERE ts < ?`).bind(t.ts - TICK_LOG_RETENCAO_DIAS * 86400).run();
  } catch { /* log durável nunca quebra o tick */ }
}
```

Nota: `filaStats` (`src/index.ts:666`) já existe e retorna `Record<status,count>` (chaves `pendente`/`processing`/`feito`/`erro`); `?? 0` cobre status ausente.

---

## 3. Instrumentação no `scheduled()` (dentro do lease B2, `src/index.ts:4497-4519`)

Substituir o bloco `try { … } catch { … } finally { … }` inteiro. As variáveis `day/hour/min` (linhas 4488-4490) e `owner` (4494) já existem no escopo acima; as novas de bookkeeping são declaradas **antes** do `try` para ficarem visíveis no `catch`/`finally`.

DE (`src/index.ts:4497-4519`):
```ts
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
        // Reflexo de Orçamento CNN → etapa Kommo (todo minuto; budget baixo p/ NÃO starvar
        // o dreno abaixo; o cursor cobre a base ao longo dos minutos). Kill-switch: ORC_ENABLED.
        if (ORC_ENABLED) {
          await produtorOrcamento(env, target, 20);
        }
        // Dreno da fila todo minuto (escreve Kommo; nunca CNN)
        await consumirFila(env, target, false, 10, 40);
      } catch (e) {
        console.error("scheduled tick falhou:", e);  // visível nos logs do Cloudflare; próximo tick reprocessa
      } finally {
        await liberarLease(env, owner);              // libera SEMPRE (mesmo com exceção) — anti-deadlock
      }
```
PARA:
```ts
      // F1: instrumentação do tick (contadores + duração) → tick_log (durável).
      const tickTs = Math.floor(Date.now() / 1000);
      const tickInicio = Date.now();
      const prod: any = {};
      const gatilhos: string[] = [];
      let cons: any = null;
      let tickOk = true;
      let tickErro: string | undefined;
      try {
        // Item 1 — Confirmação por horário (enfileira; o dreno abaixo move o lead)
        if (day >= 1 && day <= 5 && hour === 18 && min === 0) {
          prod.vespera = await produtorVespera(env, target, tomorrowBRT());   // Seg–Sex 15h BRT → D+1
          gatilhos.push("vespera-d1");
        } else if (day === 6 && hour === 14 && min === 0) {
          prod.vespera = await produtorVespera(env, target, nextMondayBRT()); // Sáb 11h BRT → segunda
          gatilhos.push("vespera-seg");
        }
        // Item 3 — Sync de base CNN→Kommo (janela −2/+14, produtor a cada 10 min)
        if (min % 10 === 0) {
          prod.sync = await produtorSync(env, target, 14);                    // windowDays=14 ⇒ −2/+14
          gatilhos.push("sync");
        }
        // Reflexo de Orçamento CNN → etapa Kommo (todo minuto; budget baixo p/ NÃO starvar
        // o dreno abaixo; o cursor cobre a base ao longo dos minutos). Kill-switch: ORC_ENABLED.
        if (ORC_ENABLED) {
          prod.orc = await produtorOrcamento(env, target, 20);
          gatilhos.push("orc");
        }
        // Dreno da fila todo minuto (escreve Kommo; nunca CNN)
        cons = await consumirFila(env, target, false, 10, 40);
      } catch (e) {
        tickOk = false;
        tickErro = String(e);
        console.error("scheduled tick falhou:", e);  // visível nos logs do Cloudflare; próximo tick reprocessa
      } finally {
        // Log durável ANTES de liberar o lease (serializado; nunca lança).
        await registrarTick(env, {
          ts: tickTs, ok: tickOk, ms: Date.now() - tickInicio, subreq: subreqUsados,
          gatilhos, cons, erro: tickErro, resumo: { gatilhos, prod, cons },
        });
        await liberarLease(env, owner);              // libera SEMPRE (mesmo com exceção) — anti-deadlock
      }
```

Pontos de projeto:
- O `registrarTick` fica **no `finally`, antes do `liberarLease`** → grava tanto ticks OK quanto os que estouraram exceção, e sempre dentro do lease (serializado).
- Só o **cron** loga. O `/debug-tick` (probe manual, dry por padrão) **intencionalmente NÃO grava** em `tick_log` — senão dry-runs poluiriam o health. (Se quiser logar `/debug-tick` real no futuro, é 1 chamada a `registrarTick` no bloco de `src/index.ts:4210-4223`; deixo fora por ora.)

---

## 4. Endpoint `/debug-tick-log` (F1 leitura + F2 sumário/backlog)

### 4a. Handler (inserir perto de `handleFilaErros`, ~`src/index.ts:3355`)

```ts
// ── F1/F2: leitura do log durável de ticks + backlog vivo da fila ──────────────
// Read-only. `?n=` (default 60, teto 500) = quantos ticks recentes; `?full=1` inclui `resumo`.
// "recentes" = sumário por tick (tick_log); "backlog" = fila_trabalho AGORA (não do log).
async function handleTickLog(req: Request, env: Env): Promise<Response> {
  await ensureSchema(env);
  const u = new URL(req.url);
  const n = Math.min(Math.max(Number(u.searchParams.get("n") ?? "60"), 1), 500);
  const full = u.searchParams.get("full") === "1";
  const now = Math.floor(Date.now() / 1000);

  // 1. Sumário por tick (últimos n)
  const cols = full
    ? "id, ts, ok, ms, subreq, gatilhos, processados, movidos, criados_b, adiados, erros, transitorios, fila_pendente, fila_erro, erro, resumo"
    : "id, ts, ok, ms, subreq, gatilhos, processados, movidos, criados_b, erros, transitorios, fila_pendente, fila_erro, erro";
  const rows = ((await env.DB.prepare(
    `SELECT ${cols} FROM tick_log ORDER BY id DESC LIMIT ?`
  ).bind(n).all()).results ?? []) as any[];

  // 2. Saúde agregada sobre os n ticks retornados (rows[0] = mais recente)
  const saude: any = {
    ticks: rows.length,
    ok: rows.filter((r) => r.ok === 1).length,
    falhas: rows.filter((r) => r.ok === 0).length,
    ultima_falha: null as any,
    ultimo_tick_ha_seg: rows.length ? now - Number(rows[0].ts) : null,
    soma_processados: 0, soma_movidos: 0, soma_criados_b: 0, soma_erros: 0, soma_transitorios: 0,
    max_subreq: 0, max_ms: 0,
  };
  for (const r of rows) {
    saude.soma_processados += Number(r.processados ?? 0);
    saude.soma_movidos     += Number(r.movidos ?? 0);
    saude.soma_criados_b   += Number(r.criados_b ?? 0);
    saude.soma_erros       += Number(r.erros ?? 0);
    saude.soma_transitorios += Number(r.transitorios ?? 0);
    saude.max_subreq = Math.max(saude.max_subreq, Number(r.subreq ?? 0));
    saude.max_ms     = Math.max(saude.max_ms, Number(r.ms ?? 0));
    if (r.ok === 0 && !saude.ultima_falha) saude.ultima_falha = { ts: r.ts, erro: r.erro };
  }

  // 3. Backlog VIVO da fila (fila_trabalho agora) — por status, por tipo (pendentes), idade
  const st = ((await env.DB.prepare(
    `SELECT status, tipo, COUNT(*) n, MIN(criado_em) mais_antigo
       FROM fila_trabalho GROUP BY status, tipo`
  ).all()).results ?? []) as any[];
  const backlog: any = { por_status: {}, pendente_por_tipo: {}, pendente_idade: {} };
  for (const r of st) {
    backlog.por_status[r.status] = (backlog.por_status[r.status] ?? 0) + Number(r.n);
    if (r.status === "pendente") {
      backlog.pendente_por_tipo[r.tipo ?? "?"] = {
        n: Number(r.n),
        idade_max_seg: r.mais_antigo ? now - Number(r.mais_antigo) : 0,
      };
    }
  }
  // Buckets de idade dos pendentes (global)
  const b = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN criado_em >  ? THEN 1 ELSE 0 END) ate_5min,
       SUM(CASE WHEN criado_em <= ? AND criado_em > ? THEN 1 ELSE 0 END) de_5_30min,
       SUM(CASE WHEN criado_em <= ? AND criado_em > ? THEN 1 ELSE 0 END) de_30_120min,
       SUM(CASE WHEN criado_em <= ? THEN 1 ELSE 0 END) mais_120min
     FROM fila_trabalho WHERE status='pendente'`
  ).bind(now - 300, now - 300, now - 1800, now - 1800, now - 7200, now - 7200).first<any>();
  backlog.pendente_idade = b ?? {};

  return Response.json({ agora: now, saude, backlog, recentes: rows });
}
```

### 4b. Rota (inserir logo após o bloco `/debug-tick`, ~`src/index.ts:4227`)

```ts
    if (pathname === "/debug-tick-log") {
      if (!discoverAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
      return handleTickLog(req, env);
    }
```

Padrão idêntico aos demais debug (auth por header `Authorization: $WEBHOOK_SECRET` via `discoverAuthOk`, `src/index.ts:4074`). Read-only → **não** chama `resetSubreq` (não faz fetch), coerente com `/debug-audit`.

Notas:
- Com `?full=1`, `resumo` volta como **string JSON** (coluna TEXT); o consumidor faz `JSON.parse`. (Se preferir objeto já parseado, dá pra `try{r.resumo=JSON.parse(r.resumo)}catch{}` no loop — opcional, deixei cru p/ simplicidade.)
- `saude` é agregada **só sobre os n retornados** (janela deslizante), não sobre a tabela toda — barato e é o que interessa p/ “está saudável agora?”.
- `backlog` é **snapshot vivo** de `fila_trabalho` (não reconstruído do `tick_log`); é aí que mora o “backlog por tipo/idade” do F2.

Exemplo de resposta (abreviado):
```json
{
  "agora": 1751560800,
  "saude": { "ticks": 60, "ok": 59, "falhas": 1,
             "ultima_falha": { "ts": 1751558100, "erro": "Kommo PATCH ... → 500" },
             "ultimo_tick_ha_seg": 12, "soma_processados": 143, "soma_movidos": 21,
             "soma_criados_b": 2, "soma_erros": 1, "soma_transitorios": 4,
             "max_subreq": 47, "max_ms": 8123 },
  "backlog": { "por_status": { "pendente": 88, "feito": 1200, "erro": 3 },
               "pendente_por_tipo": { "ORC": { "n": 80, "idade_max_seg": 5400 },
                                      "A3": { "n": 8, "idade_max_seg": 120 } },
               "pendente_idade": { "ate_5min": 8, "de_5_30min": 0, "de_30_120min": 12, "mais_120min": 68 } },
  "recentes": [ { "id": 4321, "ts": 1751560788, "ok": 1, "ms": 6100, "subreq": 39,
                  "gatilhos": "sync,orc", "processados": 10, "movidos": 1, "erros": 0,
                  "fila_pendente": 88, "fila_erro": 3, "erro": null }, ... ]
}
```

---

## 5. Plano de teste local

Pré: `.dev.vars` com `WEBHOOK_SECRET` (+ secrets CNN/Kommo se usar `--remote`); apagar depois (regra do projeto).

1. **Compila / typecheck.** `npx tsc --noEmit` (ou `npx wrangler deploy --dry-run --outdir /tmp/out`) — garante que os tipos de `registrarTick`/`handleTickLog` batem e o `scheduled()` refatorado compila.

2. **Schema criado.** `npx wrangler dev` e chamar qualquer endpoint que roda `ensureSchema` (ex.: `curl -H "Authorization: $WEBHOOK_SECRET" localhost:8787/debug-audit`). Depois:
   `npx wrangler d1 execute kommo-cnn-db --local --command "SELECT name FROM sqlite_master WHERE type='table' AND name='tick_log'"` → deve listar `tick_log`.

3. **Endpoint responde vazio.** `curl -H "Authorization: $WEBHOOK_SECRET" "localhost:8787/debug-tick-log"` → `saude.ticks=0`, `backlog.por_status` reflete a fila local. Valida o SQL (colunas, buckets) sem depender de tick.

4. **Grava 1 tick de verdade.** Subir com trigger de cron habilitado:
   `npx wrangler dev --test-scheduled` e disparar:
   `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`
   Depois `GET /debug-tick-log` → deve ter **1** linha em `recentes` com `ok=1`, `gatilhos` coerente com o minuto (sync só se `min%10===0`; orc se `ORC_ENABLED`), `ms`/`subreq` preenchidos.
   Obs.: `scheduled()` usa `target="production"` (CNN só-leitura) — os produtores farão GETs reais no CNN; é seguro (nenhuma escrita CNN). Para um teste 100% offline do logging, rodar num minuto em que `min%10!==0` e com fila vazia minimiza I/O (só o `produtorOrcamento` dispara, budget 20). Alternativa read-only edge: `npx wrangler dev --remote --test-scheduled`.

5. **Caminho de falha (`ok=0`).** Injetar erro temporário (ex.: `throw new Error("teste")` no topo de `consumirFila`, só localmente), disparar o `/__scheduled`, confirmar linha com `ok=0` e `erro="Error: teste"`, e que o **lease foi liberado** (o próximo `/__scheduled` não é pulado). Remover o throw.

6. **Poda.** Inserir linha antiga à mão e confirmar que o próximo tick a remove:
   `npx wrangler d1 execute kommo-cnn-db --local --command "INSERT INTO tick_log (ts,ok) VALUES (1,1)"`, disparar `/__scheduled`, depois `SELECT COUNT(*) FROM tick_log WHERE ts=1` → `0`.

7. **Backlog por tipo/idade.** Semear pendentes com idades distintas e conferir buckets:
   `INSERT INTO fila_trabalho (chave,tipo,status,criado_em,atualizado_em) VALUES ('t1','ORC','pendente', strftime('%s','now')-4000, 0)` (e outra recente), `GET /debug-tick-log` → `pendente_por_tipo.ORC.idade_max_seg≈4000`, bucket `de_30_120min` incrementado.

8. **Verificar o worker ao vivo (regra do projeto).** Após deploy: aguardar ~2 min e `curl -H "Authorization: $WEBHOOK_SECRET" https://kommo-cnn.clarissabergmann03.workers.dev/debug-tick-log` → confirmar ticks reais entrando a cada minuto e `saude.falhas`≈0. Cruzar `backlog.por_status` com `/debug-audit` (que já mostra `fila`) — devem casar.

9. **Limpar após teste.** Apagar `.dev.vars`; remover linhas de teste semeadas (`DELETE FROM fila_trabalho WHERE chave LIKE 't%'`); reverter qualquer throw injetado.

---

## 6. Riscos e mitigações

- **Crescimento de `tick_log`:** limitado pela poda (3 dias). Se o `DELETE` falhar repetidamente (swallow no `catch`), a tabela cresce — mas o `INSERT` continua barato e o endpoint ordena por `id DESC LIMIT n` (não varre tudo). Mitigação já embutida; se preocupar, rodar a poda só quando `min===0` (1×/h) reduz writes a ~1/tick.
- **PII no `resumo`/`recentes`:** `cons.itens` carrega `paciente_id_cnn`/`lead_id`. Endpoint atrás de `discoverAuthOk` (mesmo nível de todos os `/debug`). Sem exposição nova.
- **`ms`/`subreq` refletem o tick inteiro** (produtores + dreno), não só o dreno — é o desejado p/ health, mas não confundir com custo isolado de uma fase.
- **Best-effort:** se `registrarTick` lançar (ex.: D1 indisponível), o tick **não** é logado naquele minuto (catch silencioso, igual `audit()`), mas o fluxo e o `liberarLease` seguem. Aceitável: observabilidade não pode derrubar produção.
- **`filaStats` dentro de `registrarTick`** adiciona 1 query D1/tick (não conta subreq). Se algum dia D1 virar gargalo de latência, dá p/ reaproveitar um `filaStats` único por tick; hoje é desnecessário.
- **Refator do `scheduled()`:** o comportamento funcional é idêntico (mesmas condições e chamadas); só passa a **capturar** os retornos que antes eram descartados. Risco baixo; o `try/catch/finally` preserva a semântica anti-deadlock do lease.

---

## 7. `[DECISAO]` do dono (fora deste SPEC — não implementar agora)

- **Alerta externo (a outra metade do F1):** notificar quando `ok=0` por N ticks seguidos, ou quando `backlog.pendente_idade.mais_120min` cresce. Precisa decidir **canal** (e-mail, WhatsApp, Slack/Discord webhook, Kommo task) e **limiares**. Nada disso está aqui — o `tick_log` já deixa o dado pronto para quando o canal for definido.
- **Opcional:** logar também `/debug-tick` real (dry=0) em `tick_log`. Default deste SPEC: **não** (evita ruído no health). Trocar é trivial se o dono quiser.
- **Retenção:** `TICK_LOG_RETENCAO_DIAS=3` é palpite (≈4.320 linhas). Se quiser janela maior p/ análise histórica, é só subir a constante (custo D1 continua desprezível).

---

Arquivo-alvo (todas as âncoras): `D:/clarissa-bergmann/kommo-cnn/src/index.ts` — `ensureSchema` ~560-562, novo helper após `filaStats` ~671, `scheduled()` ~4497-4519, handler novo ~3355, rota nova ~4227.