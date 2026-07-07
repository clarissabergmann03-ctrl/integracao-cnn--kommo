const CNN_BASE = "https://api.clinicanasnuvens.com.br";
const PIPELINE_CAPTACAO = 13847079;

const STAGE_LABEL: Record<number, string> = {
  106848615: "primeiro contato",
  106848619: "consulta agendada",
  107785399: "confirmação de consulta",
  106848623: "consulta confirmada",
  106848627: "avaliação realizada",
  106848631: "tratamento proposto",
  142: "tratamento fechado",
  143: "cancelada–perdido",
};

function cnnHeaders(env: Env): HeadersInit {
  return {
    Authorization: `Basic ${btoa(`${env.CNN_BASIC_USER}:${env.CNN_BASIC_PASS}`)}`,
    "clinicaNasNuvens-cid": env.CNN_CID,
    "Content-Type": "application/json",
  };
}
async function cnnGet(path: string, env: Env) {
  const r = await fetch(`${CNN_BASE}${path}`, { headers: cnnHeaders(env) });
  const t = await r.text();
  if (!r.ok) throw new Error(`CNN ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}
function kommoBase(env: Env) { return `https://${env.KOMMO_SUBDOMAIN}.kommo.com/api/v4`; }
async function kommoGet(path: string, env: Env) {
  const r = await fetch(`${kommoBase(env)}${path}`, {
    headers: { Authorization: `Bearer ${env.KOMMO_ACCESS_TOKEN}` },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Kommo ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}
function norm(p: string) { return p.replace(/\D/g, ""); }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname, searchParams } = new URL(req.url);
    if (pathname !== "/investigar-cnn") return new Response("GET /investigar-cnn", { status: 404 });

    const pagina = parseInt(searchParams.get("pagina") ?? "1");
    const encontrados: any[] = [];
    const semMatch: string[] = [];
    const semTelefone: string[] = [];

    // ── 1. Pega todos os agendamentos CNN (range amplo: 2 anos atrás + 1 ano futuro) ──
    const di = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const df = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);

    // Constrói mapa telefone → [agendamentos]
    const phoneMap = new Map<string, any[]>();
    let pag = 0, totalPag = 1;
    while (pag < totalPag) {
      try {
        const resp = await cnnGet(
          `/agenda/lista?dataInicial=${di}&dataFinal=${df}&limite=200&pagina=${pag}`, env
        );
        totalPag = Math.max(resp.totalPaginas ?? 1, 1);
        for (const a of (resp.lista ?? [])) {
          const tel = norm(a.telefoneCelularPaciente ?? "");
          if (tel.length < 8) continue;
          const key = tel.slice(-9);
          if (!phoneMap.has(key)) phoneMap.set(key, []);
          phoneMap.get(key)!.push(a);
        }
        pag++;
      } catch { break; }
    }

    // Também busca pacientes diretamente se o telefone não apareceu em agenda
    // (pacientes cadastrados mas sem agendamento no range)

    // ── 2. Itera leads Kommo paginado ──────────────────────────────────────
    let page = pagina, hasMore = true;
    let processados = 0;
    const MAX_LEADS = 250; // processa até 250 por chamada

    while (hasMore && processados < MAX_LEADS) {
      let resp: any;
      try {
        resp = await kommoGet(
          `/leads?with=contacts&limit=50&page=${page}&filter[pipeline_id]=${PIPELINE_CAPTACAO}`, env
        );
      } catch { break; }

      const leads: any[] = resp._embedded?.leads ?? [];
      if (!leads.length) { hasMore = false; break; }

      for (const lead of leads) {
        if (processados >= MAX_LEADS) break;
        processados++;

        const contactId = lead._embedded?.contacts?.[0]?.id;
        if (!contactId) { semTelefone.push(`${lead.id}:${lead.name}`); continue; }

        let phones: string[] = [];
        try {
          const c = await kommoGet(`/contacts/${contactId}`, env);
          phones = (c.custom_fields_values ?? [])
            .filter((f: any) => f.field_code === "PHONE")
            .flatMap((f: any) => f.values.map((v: any) => norm(v.value)));
        } catch { semTelefone.push(`${lead.id}:${lead.name}`); continue; }

        if (!phones.length) { semTelefone.push(`${lead.id}:${lead.name}`); continue; }

        // Tenta match pelo mapa de agendamentos CNN
        let cnnAgendas: any[] | null = null;
        let telefoneUsado = "";
        for (const p of phones) {
          const key = p.slice(-9);
          if (phoneMap.has(key)) {
            cnnAgendas = phoneMap.get(key)!;
            telefoneUsado = p;
            break;
          }
        }

        // Se não achou via agenda, tenta buscar paciente diretamente por telefone
        if (!cnnAgendas) {
          for (const p of phones) {
            const q = p.slice(-11);
            try {
              const pr = await cnnGet(`/paciente/lista?telefoneCelularContem=${encodeURIComponent(q)}&limite=5`, env);
              const lista: any[] = pr?.lista ?? [];
              // Filtra pelo match exato dos últimos 9 dígitos
              const paciente = lista.find((px: any) => {
                const pt = norm(px.contato?.telefoneCelular ?? px.contato?.telefone ?? "");
                return pt.slice(-9) === p.slice(-9);
              });
              if (paciente) {
                // Busca agendamentos desse paciente
                try {
                  const ar = await cnnGet(
                    `/agenda/lista?idPaciente=${paciente.id}&dataInicial=${di}&dataFinal=${df}&limite=50`, env
                  );
                  cnnAgendas = ar?.lista ?? [];
                  if (cnnAgendas.length === 0) cnnAgendas = [{ _sem_agendamento: true, paciente_id: paciente.id, nome: paciente.nome }];
                } catch {
                  cnnAgendas = [{ _sem_agendamento: true, paciente_id: paciente.id, nome: paciente.nome }];
                }
                telefoneUsado = p;
                break;
              }
            } catch { continue; }
          }
        }

        if (!cnnAgendas) {
          semMatch.push(`${lead.id}:${lead.name}`);
          continue;
        }

        // Tem match CNN — monta resultado completo
        encontrados.push({
          kommo_lead_id:    lead.id,
          kommo_lead_nome:  lead.name,
          kommo_etapa:      STAGE_LABEL[lead.status_id] ?? String(lead.status_id),
          kommo_status_id:  lead.status_id,
          telefone_match:   telefoneUsado,
          cnn_agendamentos: cnnAgendas.map((a: any) => a._sem_agendamento
            ? { tipo: "paciente_sem_agendamento", paciente_id: a.paciente_id, nome: a.nome }
            : {
                id:         a.id,
                data:       a.data,
                hora:       (a.horaInicio ?? "").slice(0, 5),
                status:     a.status,
                paciente_id: a.idPaciente,
              }
          ),
        });
      }

      page++;
      if (leads.length < 50) hasMore = false;
    }

    return Response.json({
      resumo: {
        cnn_agendamentos_no_range: [...phoneMap.values()].flat().length,
        cnn_pacientes_unicos:      phoneMap.size,
        kommo_leads_processados:   processados,
        encontrados_no_cnn:        encontrados.length,
        sem_telefone:              semTelefone.length,
        sem_match_cnn:             semMatch.length,
      },
      encontrados,
      sem_match_amostra: semMatch.slice(0, 20),
    });
  },
  async scheduled(): Promise<void> {},
};

interface Env {
  DB: D1Database;
  CNN_CID: string;
  CNN_BASIC_USER: string;
  CNN_BASIC_PASS: string;
  KOMMO_ACCESS_TOKEN: string;
  KOMMO_SUBDOMAIN: string;
  WEBHOOK_SECRET: string;
}
