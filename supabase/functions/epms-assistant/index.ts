// EPMS admin assistant: the admin types or dictates what she wants (with signatures, sample forms or job
// descriptions attached), Claude reads and edits the staff record through the tools below, and the build
// starts straight away. Only the admin passcode opens it; the Anthropic key and the GitHub token live in
// this project's secrets (ANTHROPIC_API_KEY, GH_DISPATCH_TOKEN) and never reach the browser.
//
// One "chat" call = one Claude turn, streamed back to the browser. If Claude asks for tools, the browser sends
// them to "tools", gets the results, and calls "chat" again, so no single request runs long.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { SYSTEM_PROMPT } from "./prompt.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const GH_TOKEN = Deno.env.get("GH_DISPATCH_TOKEN") ?? "";
const REPO = "buildnet6/uch-epms-form";
const MODELS = ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"];
const SIG_FIELD: Record<string, string> = { appraisee: "signature", supervisor: "supervisor_signature", cso: "cso_signature" };
const ROOTS = new Set(["employee", "supervisor", "countersigning_officer", "kras", "monthly", "quarterly", "extras", "contract", "own_contract"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("EPMS_ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const clip = (v: unknown, n = 200) => (typeof v === "string" ? v.trim().slice(0, n) : null);

// ---------- admin passcode (same hash and lockout as the dashboard) ----------
const unb64 = (x: string) => Uint8Array.from(atob(x), (c) => c.charCodeAt(0));
async function pbkdf2(pass: string, salt: Uint8Array, iter: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: iter }, key, 256));
}
function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
const clientIp = (req: Request) =>
  (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "?").split(",")[0].trim().slice(0, 64);
async function adminOk(key: unknown, ip: string): Promise<true | false | "locked"> {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { count } = await db.from("epms_admin_failures").select("id", { count: "exact", head: true }).eq("ip", ip).gte("at", since);
  if ((count ?? 0) >= 8) return "locked";
  const { data } = await db.from("epms_admin").select("pass_hash").eq("id", 1).maybeSingle();
  let ok = false;
  if (data?.pass_hash && typeof key === "string" && key.length >= 6 && key.length <= 200) {
    const [, it, salt, hash] = String(data.pass_hash).split("$");
    ok = sameBytes(await pbkdf2(key, unb64(salt), Number(it)), unb64(hash));
  }
  if (!ok) { await db.from("epms_admin_failures").insert({ ip }); return false; }
  return true;
}

// ---------- helpers ----------
const T = (s: unknown) => (s ? new Date(String(s)).getTime() : 0);
function formComplete(data: any) {
  const months = Array.isArray(data?.monthly) ? data.monthly.slice(0, 12) : [];
  if (months.length < 12) return false;
  return months.every((m: any) => {
    const rows = (Array.isArray(m?.rows) ? m.rows : []).filter((r: any) => r && String(r.kra ?? "").trim());
    return rows.length > 0 && rows.every((r: any) => String(r.output ?? "").trim() !== "");
  });
}
function withoutSignatures(data: any) {
  const d = structuredClone(data ?? {});
  for (const f of Object.values(SIG_FIELD)) {
    const s = d[f];
    d[f] = s && typeof s === "object" && s.png ? { present: true, approved: !!s.approved } : null;
  }
  return d;
}
function setPath(obj: any, path: string, value: unknown, del: boolean) {
  const parts = path.split(".").filter(Boolean);
  if (!parts.length || !ROOTS.has(parts[0])) throw new Error(`path must start with one of ${[...ROOTS].join(", ")}`);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i], nextIsIndex = /^\d+$/.test(parts[i + 1]);
    const k: string | number = Array.isArray(cur) ? Number(p) : p;
    if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== "object") cur[k] = nextIsIndex ? [] : {};
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  const k: string | number = Array.isArray(cur) ? Number(last) : last;
  if (del) { if (Array.isArray(cur)) cur.splice(Number(k), 1); else delete cur[k]; }
  else cur[k] = value;
}
function tidy(data: any) {
  // keep the shape the builder expects: 12 months, at most 10 tasks a month, outputs as text
  if (data.monthly !== undefined) {
    if (!Array.isArray(data.monthly)) throw new Error("monthly must be a list of 12 months");
    while (data.monthly.length < 12) data.monthly.push({ rows: [] });
    data.monthly = data.monthly.slice(0, 12).map((m: any, i: number) => {
      const rows = (Array.isArray(m?.rows) ? m.rows : []).slice(0, 10).map((r: any) => ({
        ...r, code: String(r?.code ?? ""), kra: String(r?.kra ?? ""),
        output: r?.output === null || r?.output === undefined ? "" : String(r.output), issues: String(r?.issues ?? ""),
      }));
      return { ...(m ?? {}), month: MONTHS[i], rows };
    });
  }
  if (data.quarterly !== undefined && !Array.isArray(data.quarterly)) throw new Error("quarterly must be a list of 4");
  return data;
}
function summaryCols(data: any) {
  const e = data?.employee ?? {};
  return { surname: clip(e.surname), first_name: clip(e.first_name), ippis: clip(e.ippis, 40), phone: clip(e.phone, 40),
           email: clip(e.email), unit: clip(e.unit) };
}
async function logEvent(id: string, detail: string) {
  await db.from("epms_events").insert({ submission_id: id, kind: "admin", detail: `Assistant: ${detail}`.slice(0, 500) });
}
export async function dispatchBuild(): Promise<boolean> {
  if (!GH_TOKEN) return false;
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/build-workbooks.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
               "User-Agent": "epms-assistant" },
    body: JSON.stringify({ ref: "main" }),
  });
  return r.status === 204;
}
// the hospital contract task list, published with this repository (kept in memory after the first use)
const CATALOG_URL = "https://raw.githubusercontent.com/buildnet6/uch-epms-form/main/supabase/functions/epms-assistant/catalog.json";
let CATALOG: any[] | null = null;
async function catalog(): Promise<any[]> {
  if (!CATALOG) { const r = await fetch(CATALOG_URL); if (!r.ok) throw new Error("task list unavailable"); CATALOG = await r.json(); }
  return CATALOG!;
}
async function getRow(id: string) {
  const { data } = await db.from("epms_submissions").select("*").eq("id", id).maybeSingle();
  return data;
}

// ---------- tools Claude can use ----------
const TOOLS = [
  { name: "find_records", description: "Find staff records by name, IPPIS, phone or unit. Returns up to 10 matches with id and status.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_record", description: "Read one staff record in full (signature images are shown only as present/absent), with payment and build status.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "contract_catalog", description: "The hospital performance contract task list (code, KRA text, objective, weight, target, KPI, unit, bands). Optional search filters by code or words.",
    input_schema: { type: "object", properties: { search: { type: "string" } } } },
  { name: "update_record", description: "Change parts of a record. Each change sets (or deletes) a dotted path such as 'employee.designation', 'monthly.3', 'monthly.3.rows', 'quarterly', 'extras', 'kras', 'own_contract'. Keep each call to at most three months of monthly data. Always give a one-line summary for the activity log.",
    input_schema: { type: "object", properties: {
      id: { type: "string" },
      changes: { type: "array", items: { type: "object", properties: {
        path: { type: "string" }, value: {}, delete: { type: "boolean" } }, required: ["path"] } },
      summary: { type: "string" } }, required: ["id", "changes", "summary"] } },
  { name: "set_signature", description: "Put an uploaded, cleaned signature on the record for the appraisee, the supervisor or the counter-signing officer.",
    input_schema: { type: "object", properties: { id: { type: "string" }, role: { type: "string", enum: ["appraisee", "supervisor", "cso"] },
      file_id: { type: "string" } }, required: ["id", "role", "file_id"] } },
  { name: "create_record", description: "Create a new staff record (when someone is not in the system yet). Returns the new id.",
    input_schema: { type: "object", properties: { employee: { type: "object" }, supervisor: { type: "object" },
      countersigning_officer: { type: "object" }, note: { type: "string" } }, required: ["employee"] } },
  { name: "set_payment", description: "Only when the admin says so: mark the record paid (manual confirmation) or complimentary.",
    input_schema: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["paid", "complimentary"] },
      amount: { type: "number" }, note: { type: "string" } }, required: ["id", "status"] } },
  { name: "build_now", description: "Start building her workbook, printed PDF and summary immediately (ready in about two minutes).",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "build_status", description: "Whether her files are up to date, being built, or blocked (and why), with the last quarterly scores and flags.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

async function runTool(name: string, input: any): Promise<unknown> {
  const id = typeof input?.id === "string" && UUID.test(input.id) ? input.id : null;
  switch (name) {
    case "find_records": {
      const q = String(input?.query ?? "").trim().replace(/[%,()]/g, " ").slice(0, 60);
      if (!q) return { error: "empty query" };
      const like = `%${q}%`;
      const { data } = await db.from("epms_submissions")
        .select("id, surname, first_name, ippis, unit, payment_status, complimentary, archived, is_test, built_at, build_report, data")
        .or(`surname.ilike.${like},first_name.ilike.${like},ippis.ilike.${like},unit.ilike.${like},phone.ilike.${like}`).limit(10);
      return (data ?? []).map((r: any) => ({ id: r.id, name: [r.first_name, r.surname].filter(Boolean).join(" "),
        designation: r.data?.employee?.designation ?? "", unit: r.unit, ippis: r.ippis, paid: r.payment_status === "paid",
        complimentary: r.complimentary, archived: r.archived, test: r.is_test, built: !!r.built_at,
        quarters: r.build_report?.quarters ?? null, tasks: (r.data?.kras ?? []).length }));
    }
    case "get_record": {
      if (!id) return { error: "bad id" };
      const r = await getRow(id); if (!r) return { error: "not found" };
      return { id, payment_status: r.payment_status, complimentary: r.complimentary, admin_note: r.admin_note,
               form_complete: formComplete(r.data), last_build: { built_at: r.built_at, quarters: r.build_report?.quarters ?? null,
               flags: r.build_report?.flags ?? [], met: r.build_report?.results_met ?? null, total: r.build_report?.results_total ?? null },
               data: withoutSignatures(r.data) };
    }
    case "contract_catalog": {
      const s = String(input?.search ?? "").toLowerCase().trim();
      const rows = await catalog();
      if (!s) return rows;
      const words = s.split(/\s+/);
      return rows.filter((x) => words.some((w) => `${x.code} ${x.kra} ${x.objective}`.toLowerCase().includes(w)));
    }
    case "update_record": {
      if (!id) return { error: "bad id" };
      const r = await getRow(id); if (!r) return { error: "not found" };
      const data = structuredClone(r.data ?? {});
      const changes = Array.isArray(input?.changes) ? input.changes : [];
      if (!changes.length) return { error: "no changes" };
      try {
        for (const c of changes) setPath(data, String(c?.path ?? ""), c?.value, !!c?.delete);
        tidy(data);
      } catch (e) { return { error: String((e as Error).message) }; }
      const { error } = await db.from("epms_submissions").update({ data, ...summaryCols(data) }).eq("id", id);
      if (error) return { error: "could not save" };
      await logEvent(id, String(input?.summary ?? "record updated"));
      return { ok: true, changed: changes.map((c: any) => c.path), form_complete: formComplete(data) };
    }
    case "set_signature": {
      if (!id) return { error: "bad id" };
      const field = SIG_FIELD[String(input?.role)]; if (!field) return { error: "role must be appraisee, supervisor or cso" };
      const { data: f } = await db.from("epms_assistant_files").select("kind, content").eq("id", String(input?.file_id ?? "")).maybeSingle();
      if (!f || f.kind !== "signature" || !String(f.content).startsWith("data:image/png;base64,")) return { error: "no such signature file" };
      const r = await getRow(id); if (!r) return { error: "not found" };
      const data = structuredClone(r.data ?? {});
      data[field] = { png: f.content, approved: true, consent: true };
      const { error } = await db.from("epms_submissions").update({ data }).eq("id", id);
      if (error) return { error: "could not save" };
      await logEvent(id, `${input.role} signature added`);
      return { ok: true };
    }
    case "create_record": {
      const P = (o: any) => ({ surname: clip(o?.surname) ?? "", first_name: clip(o?.first_name) ?? "", other_name: clip(o?.other_name) ?? "",
        designation: clip(o?.designation) ?? "", ippis: clip(o?.ippis, 40) ?? "", email: clip(o?.email) ?? "", phone: clip(o?.phone, 40) ?? "" });
      const emp = { ...P(input?.employee), department: clip(input?.employee?.department) || "Clinical Nursing", unit: clip(input?.employee?.unit) ?? "" };
      if (!emp.surname || !emp.first_name) return { error: "surname and first name are required" };
      const data = { form: "UCH-EPMS-DETAILS", version: 1, year: 2025, source: "admin", employee: emp,
        supervisor: P(input?.supervisor), countersigning_officer: P(input?.countersigning_officer), kras: [],
        monthly: MONTHS.map((m) => ({ month: m, rows: [] })),
        extras: { outstanding_performance: "", areas_of_improvement: "", training_needs: "", future_goals: "", other_feedback: "" } };
      const { data: row, error } = await db.from("epms_submissions").insert({ ...summaryCols(data), year: 2025, data, source: "admin",
        admin_note: clip(input?.note, 2000) || "Created by the assistant." }).select("id").single();
      if (error) return { error: "could not create" };
      await logEvent(row.id, `record created for ${emp.first_name} ${emp.surname}`);
      return { ok: true, id: row.id };
    }
    case "set_payment": {
      if (!id) return { error: "bad id" };
      const up = input?.status === "complimentary" ? { complimentary: true }
        : { payment_status: "paid", payment_method: "manual", amount_paid: Number(input?.amount) > 0 ? Number(input.amount) : 3500,
            currency: "NGN", paid_at: new Date().toISOString(), payment_note: clip(input?.note, 300) || "Payment confirmed by admin." };
      const { error } = await db.from("epms_submissions").update(up).eq("id", id);
      if (error) return { error: "could not save" };
      await logEvent(id, input?.status === "complimentary" ? "made complimentary" : "marked paid");
      return { ok: true };
    }
    case "build_now": {
      if (!id) return { error: "bad id" };
      const r = await getRow(id); if (!r) return { error: "not found" };
      if (!(r.payment_status === "paid" || r.complimentary)) return { error: "not paid or complimentary yet, so the builder will skip her" };
      if (!formComplete(r.data)) return { error: "form not complete: every month needs at least one task with a result" };
      await db.from("epms_submissions").update({ build_requested_at: new Date().toISOString(), build_failed_at: null, build_error: null }).eq("id", id);
      const started = await dispatchBuild();
      return { ok: true, started_immediately: started, note: started ? "ready in about two minutes" : "queued for the next scheduled build" };
    }
    case "build_status": {
      if (!id) return { error: "bad id" };
      const r = await getRow(id); if (!r) return { error: "not found" };
      const last = Math.max(T(r.data_updated_at), T(r.build_requested_at));
      const state = !(r.payment_status === "paid" || r.complimentary) ? "blocked: not paid"
        : !formComplete(r.data) ? "blocked: form incomplete"
        : r.build_failed_at && T(r.build_failed_at) >= last ? `failed: ${r.build_error ?? ""}`
        : r.built_at && T(r.built_at) >= last ? "ready" : "building";
      return { state, built_at: r.built_at, quarters: r.build_report?.quarters ?? null, flags: r.build_report?.flags ?? [],
               met: r.build_report?.results_met ?? null, total: r.build_report?.results_total ?? null };
    }
  }
  return { error: `unknown tool ${name}` };
}

// ---------- routes ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const raw = await req.text();
  if (raw.length > 30_000_000) return json({ error: "too_large" }, 413);
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400); }
  const auth = await adminOk(body?.key, clientIp(req));
  if (auth === "locked") return json({ error: "locked" }, 429);
  if (!auth) return json({ error: "wrong_passcode" }, 401);

  if (body.action === "ping") return json({ ok: true, ai: !!ANTHROPIC_KEY, fast_build: !!GH_TOKEN, models: MODELS });

  if (body.action === "upload") {
    // a cleaned signature (PNG data URL) or a converted document kept for the tools to use
    const kind = body.kind === "signature" ? "signature" : "document";
    const content = String(body.content ?? "");
    if (kind === "signature" && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(content)) return json({ error: "bad_png" }, 400);
    if (content.length > 4_000_000) return json({ error: "too_large" }, 413);
    const { data, error } = await db.from("epms_assistant_files").insert({ kind, name: clip(body.name, 200) ?? "", content }).select("id").single();
    if (error) return json({ error: "db" }, 500);
    return json({ ok: true, id: data.id });
  }

  if (body.action === "tools") {
    const calls = Array.isArray(body.calls) ? body.calls.slice(0, 20) : [];
    const results = [];
    for (const c of calls) {
      let out: unknown;
      try { out = await runTool(String(c?.name), c?.input ?? {}); } catch (e) { out = { error: String((e as Error).message ?? e) }; }
      results.push({ type: "tool_result", tool_use_id: String(c?.id ?? ""), content: JSON.stringify(out).slice(0, 180_000) });
    }
    return json({ results });
  }

  if (body.action === "chat") {
    if (!ANTHROPIC_KEY) return json({ error: "no_ai_key" }, 503);
    const model = MODELS.includes(body.model) ? body.model : MODELS[0];
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return json({ error: "no_messages" }, 400);
    let focus = "";
    if (typeof body.focus_id === "string" && UUID.test(body.focus_id)) {
      const { data: f } = await db.from("epms_submissions").select("first_name, surname, unit").eq("id", body.focus_id).maybeSingle();
      if (f) focus = `The admin has this record open: ${[f.first_name, f.surname].filter(Boolean).join(" ")}${f.unit ? ` (${f.unit})` : ""}, id ${body.focus_id}. Unless told otherwise, the instruction is about her.`;
    }
    const tools = TOOLS.map((t, i) => (i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
    const system: any[] = [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];
    if (focus) system.push({ type: "text", text: focus });
    system.push({ type: "text", text: `Today is ${new Date().toISOString().slice(0, 10)}.` });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 12000, system, tools, messages, stream: true }),
    });
    if (!r.ok || !r.body) {
      let msg = ""; try { msg = (await r.json())?.error?.message ?? ""; } catch { /* */ }
      return json({ error: "ai_error", status: r.status, message: msg.slice(0, 300) }, 502);
    }
    return new Response(r.body, { headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }
  return json({ error: "unknown_action" }, 400);
});
