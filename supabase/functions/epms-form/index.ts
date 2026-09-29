// UCH Nurses EPMS form backend
// - config:  price and whether payments are switched on
// - save:    create or update a nurse's submission (identified by a private edit token);
//            optional approved signatures (nurse, supervisor, counter-signing officer; small PNGs) travel inside it
// - load:    fetch a submission by edit token (also re-checks an unconfirmed payment)
// - start:   record the reference of a payment attempt just before checkout opens
// - verify / check: confirm a Flutterwave payment server-side and mark the submission paid
// - /webhook: optional Flutterwave webhook (not used while the Flutterwave account is shared)
// - admin:   owner's dashboard (passcode-protected, with sign-in lockout): overview, detail (full record), set, recheck
//            (deep Flutterwave search with findings), mark_paid / unmark_paid (manual confirmation), create, change_key
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const PRICE = Number(Deno.env.get("EPMS_PRICE") ?? "3500");
const CURRENCY = "NGN";
const FLW = "https://api.flutterwave.com/v3";
const FLW_SECRET_KEY = Deno.env.get("FLW_SECRET_KEY") ?? "";
const FLW_SECRET_HASH = Deno.env.get("FLW_SECRET_HASH") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("EPMS_ALLOWED_ORIGIN") ?? "*";
const MAX_BYTES = 640_000;
const MAX_SIG = 160_000;   // each approved signature: a small transparent PNG as a data URL
const SIG_FIELDS = ["signature", "supervisor_signature", "cso_signature"];   // nurse, supervisor, counter-signing officer
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const clip = (v: unknown, n = 200) => (typeof v === "string" ? v.trim().slice(0, n) : null);

function summary(data: any) {
  const e = data?.employee ?? {};
  return {
    surname: clip(e.surname), first_name: clip(e.first_name), ippis: clip(e.ippis, 40),
    phone: clip(e.phone, 40), email: clip(e.email), unit: clip(e.unit),
    year: Number.isInteger(data?.year) ? data.year : 2025,
  };
}

async function flwGet(path: string) {
  try {
    const r = await fetch(`${FLW}${path}`, { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` } });
    return await r.json();
  } catch { return null; }
}
const belongsTo = (row: any, ref: unknown) =>
  typeof ref === "string" && (ref === row.tx_ref || ref.startsWith(row.tx_ref + "-"));

async function markPaidIfValid(row: any, tx: any) {
  if (!tx) return { ok: false, reason: "not_found" };
  const good = tx.status === "successful" && belongsTo(row, tx.tx_ref) &&
    tx.currency === CURRENCY && Number(tx.amount) >= PRICE;
  if (!good) return { ok: false, reason: tx.status === "successful" ? "mismatch" : "pending" };
  if (row.payment_status !== "paid") {
    const { error } = await db.from("epms_submissions").update({
      payment_status: "paid", amount_paid: tx.amount, currency: tx.currency,
      flw_transaction_id: String(tx.id), paid_at: new Date().toISOString(), payment_method: "flutterwave",
    }).eq("id", row.id);
    if (error) return { ok: false, reason: "db_error" };
  }
  return { ok: true };
}

// Every checkout attempt this nurse made (newest first), from the saved history plus the last one.
function attemptRefs(row: any): string[] {
  const refs = [...(Array.isArray(row.tx_refs) ? row.tx_refs : [])].reverse();
  if (row.last_tx_ref) refs.unshift(row.last_tx_ref);
  return [...new Set(refs.filter((r: unknown) => typeof r === "string" && belongsTo(row, r)))].slice(0, 25);
}
const txBrief = (t: any) => t && ({
  id: t.id, tx_ref: t.tx_ref, status: t.status, amount: t.amount, currency: t.currency, at: t.created_at,
  method: t.payment_type, email: t.customer?.email ?? null, name: t.customer?.name ?? null,
  note: t.processor_response ?? null,
});

// Look for a successful payment for this submission in every way we can:
// 1) the transaction id the checkout returned, 2) every checkout attempt's reference,
// 3) recent payments from the nurse's email, 4) (admin check only) every Flutterwave payment
//    since she started, matched on this submission's reference.
// Returns whether she is paid and, for the admin, what Flutterwave holds for her.
async function reconcile(row: any, transactionId?: string, deep = false): Promise<{ paid: boolean; found: any[]; searched: string[] }> {
  const found: any[] = [], searched: string[] = [];
  if (!FLW_SECRET_KEY) return { paid: row.payment_status === "paid", found, searched: ["payments not configured"] };
  if (row.payment_status === "paid") return { paid: true, found, searched };
  await db.from("epms_submissions").update({ last_checked_at: new Date().toISOString() }).eq("id", row.id);
  const seen = new Set<string>();
  const consider = async (tx: any) => {
    if (!tx || !belongsTo(row, tx.tx_ref)) return false;
    if (!seen.has(String(tx.id))) { seen.add(String(tx.id)); found.push(txBrief(tx)); }
    return (await markPaidIfValid(row, tx)).ok;
  };
  if (transactionId) {
    searched.push("checkout transaction id");
    const v = await flwGet(`/transactions/${encodeURIComponent(transactionId)}/verify`);
    if (await consider(v?.data)) return { paid: true, found, searched };
  }
  const refs = attemptRefs(row);
  searched.push(`${refs.length} checkout attempt(s)`);
  for (const ref of refs) {
    const v = await flwGet(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(ref)}`);
    if (await consider(v?.data)) return { paid: true, found, searched };
  }
  const from = new Date(new Date(row.created_at).getTime() - 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  if (row.email) {
    searched.push("payments from " + row.email);
    const list = await flwGet(`/transactions?customer_email=${encodeURIComponent(row.email)}&from=${from}&to=${to}`);
    for (const t of (list?.data ?? [])) {
      if (!belongsTo(row, t?.tx_ref)) continue;
      const v = await flwGet(`/transactions/${encodeURIComponent(String(t.id))}/verify`);  // never trust a list entry alone
      if (await consider(v?.data ?? t)) return { paid: true, found, searched };
    }
  }
  if (deep) {
    searched.push("all Flutterwave payments since she started");
    for (let page = 1; page <= 20; page++) {
      const list = await flwGet(`/transactions?from=${from}&to=${to}&page=${page}`);
      const items = list?.data ?? [];
      for (const t of items) {
        if (!belongsTo(row, t?.tx_ref)) continue;
        const v = t.status === "successful" ? await flwGet(`/transactions/${encodeURIComponent(String(t.id))}/verify`) : null;
        if (await consider(v?.data ?? t)) return { paid: true, found, searched };
      }
      const pi = list?.meta?.page_info;
      if (!items.length || !pi || page >= Number(pi.total_pages || 1)) break;
    }
  }
  return { paid: false, found, searched };
}

async function rowByToken(token: string) {
  const { data } = await db.from("epms_submissions").select("*").eq("edit_token", token).maybeSingle();
  return data;
}

// ---------- admin ----------
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function pbkdf2(pass: string, salt: Uint8Array, iter: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}
function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
async function hashKey(pass: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iter = 200_000;
  return `pbkdf2$${iter}$${b64(salt)}$${b64(await pbkdf2(pass, salt, iter))}`;
}
const clientIp = (req: Request) =>
  (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "?").split(",")[0].trim().slice(0, 64);

// true = signed in; "locked" = too many wrong tries from this address; false = wrong passcode
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

const ADMIN_COLS = "id, edit_token, tx_ref, surname, first_name, ippis, phone, email, unit, payment_status, amount_paid, currency, " +
  "paid_at, filled_at, delivered_at, admin_note, complimentary, is_test, source, created_at, data_updated_at, last_tx_ref, last_checked_at, fill_notes, " +
  "designation:data->employee->>designation, other_name:data->employee->>other_name, monthly:data->monthly, kras:data->kras, extras:data->extras, " +
  "sup:data->supervisor, cso:data->countersigning_officer, sig_me:data->signature->approved, sig_sup:data->supervisor_signature->approved, " +
  "sig_cso:data->cso_signature->approved, tx_refs, payment_method, payment_note, archived";

async function admin(req: Request, body: any) {
  const ip = clientIp(req);
  const auth = await adminOk(body.key, ip);
  if (auth === "locked") return json({ error: "locked" }, 429);
  if (!auth) return json({ error: "wrong_passcode" }, 401);
  const op = body.op;
  const id = typeof body.id === "string" && UUID.test(body.id) ? body.id : null;

  if (op === "overview") {
    const { data: rows, error } = await db.from("epms_submissions").select(ADMIN_COLS).order("created_at", { ascending: false }).limit(2000);
    if (error) return json({ error: "db_error" }, 500);
    const { data: events } = await db.from("epms_events").select("id, submission_id, kind, detail, at").order("at", { ascending: false }).limit(300);
    return json({ rows, events, price: PRICE, now: new Date().toISOString() });
  }
  if (op === "detail" && id) {
    // everything about one nurse: her full answers (with signatures), payment trail and activity
    const { data: row } = await db.from("epms_submissions").select("*").eq("id", id).maybeSingle();
    if (!row) return json({ error: "not_found" }, 404);
    const { data: events } = await db.from("epms_events").select("kind, detail, at").eq("submission_id", id).order("at", { ascending: false }).limit(200);
    const d = row.data ?? {};
    const png = (s: any) => (s && typeof s.png === "string" ? s.png : null);
    const { data: twins } = await db.from("epms_submissions")
      .select("id, created_at, data_updated_at, payment_status, archived, kras:data->kras")
      .neq("id", id).or(`ippis.eq.${String(row.ippis ?? "-").replace(/[^0-9A-Za-z]/g, "") || "-"},phone.eq.${String(row.phone ?? "-").replace(/[^0-9+]/g, "") || "-"}`);
    return json({
      data: { ...d, signature: undefined, supervisor_signature: undefined, cso_signature: undefined },
      signatures: { sig_me: png(d.signature), sig_sup: png(d.supervisor_signature), sig_cso: png(d.cso_signature) },
      attempts: attemptRefs(row), events, twins: twins ?? [],
    });
  }
  if (op === "set" && id) {
    const f = body.fields ?? {}, up: Record<string, unknown> = {};
    if (typeof f.delivered === "boolean") up.delivered_at = f.delivered ? new Date().toISOString() : null;
    if (typeof f.filled === "boolean") up.filled_at = f.filled ? new Date().toISOString() : null;
    if (typeof f.complimentary === "boolean") up.complimentary = f.complimentary;
    if (typeof f.is_test === "boolean") up.is_test = f.is_test;
    if (typeof f.admin_note === "string") up.admin_note = f.admin_note.slice(0, 2000) || null;
    if (typeof f.archived === "boolean") up.archived = f.archived;
    if (!Object.keys(up).length) return json({ error: "nothing_to_change" }, 400);
    const { error } = await db.from("epms_submissions").update(up).eq("id", id);
    return error ? json({ error: "db_error" }, 500) : json({ ok: true });
  }
  if (op === "recheck" && id) {
    const { data: row } = await db.from("epms_submissions").select("*").eq("id", id).maybeSingle();
    if (!row) return json({ error: "not_found" }, 404);
    const r = await reconcile(row, undefined, true);
    return json({ payment_status: r.paid ? "paid" : "unpaid", found: r.found, searched: r.searched, configured: Boolean(FLW_SECRET_KEY) });
  }
  if (op === "mark_paid" && id) {
    // the owner confirmed the money arrived another way (e.g. bank credit seen); recorded as a manual confirmation
    const amount = Number(body.amount);
    const note = clip(body.note, 300);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return json({ error: "bad_amount" }, 400);
    if (!note) return json({ error: "note_required" }, 400);
    const { data: row } = await db.from("epms_submissions").select("payment_status").eq("id", id).maybeSingle();
    if (!row) return json({ error: "not_found" }, 404);
    if (row.payment_status === "paid") return json({ ok: true, already: true });
    const { error } = await db.from("epms_submissions").update({ payment_status: "paid", amount_paid: amount, currency: CURRENCY,
      paid_at: new Date().toISOString(), payment_method: "manual", payment_note: note, flw_transaction_id: null }).eq("id", id);
    return error ? json({ error: "db_error" }, 500) : json({ ok: true });
  }
  if (op === "unmark_paid" && id) {
    // only a manual confirmation can be undone here; a Flutterwave-verified payment stays
    const { data: row } = await db.from("epms_submissions").select("payment_method").eq("id", id).maybeSingle();
    if (!row) return json({ error: "not_found" }, 404);
    if (row.payment_method !== "manual") return json({ error: "not_manual" }, 400);
    const { error } = await db.from("epms_submissions").update({ payment_status: "unpaid", amount_paid: null, paid_at: null,
      payment_method: null, payment_note: null }).eq("id", id);
    return error ? json({ error: "db_error" }, 500) : json({ ok: true });
  }
  if (op === "change_key") {
    const nk = body.new_key;
    if (typeof nk !== "string" || nk.length < 10 || nk.length > 200) return json({ error: "weak_passcode" }, 400);
    const { error } = await db.from("epms_admin").update({ pass_hash: await hashKey(nk), changed_at: new Date().toISOString() }).eq("id", 1);
    return error ? json({ error: "db_error" }, 500) : json({ ok: true });
  }
  if (op === "create") {
    // onboard a nurse by hand (e.g. she sent her workbook in): creates her account and returns her private link
    const P = (o: any) => ({ surname: clip(o?.surname) ?? "", first_name: clip(o?.first_name) ?? "", other_name: clip(o?.other_name) ?? "",
      designation: clip(o?.designation) ?? "", ippis: clip(o?.ippis, 40) ?? "", email: clip(o?.email) ?? "", phone: clip(o?.phone, 40) ?? "" });
    const emp = { ...P(body.employee), department: "Clinical Nursing", unit: clip(body.employee?.unit) ?? "" };
    if (!emp.surname || !emp.first_name) return json({ error: "name_required" }, 400);
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const data = { form: "UCH-EPMS-DETAILS", version: 1, year: 2025, source: "admin", employee: emp,
      supervisor: P(body.supervisor), countersigning_officer: P(body.countersigning_officer), kras: [],
      monthly: months.map((m) => ({ month: m, rows: [0, 1].map(() => ({ code: "", kra: "", output: "", issues: "" })) })),
      extras: { outstanding_performance: "", areas_of_improvement: "", training_needs: "", future_goals: "", other_feedback: "" } };
    const { data: row, error } = await db.from("epms_submissions").insert({ ...summary(data), data, source: "admin",
      admin_note: clip(body.note, 2000) || "Onboarded by admin." }).select("id, edit_token").single();
    return error ? json({ error: "db_error" }, 500) : json({ ok: true, id: row.id, edit_token: row.edit_token });
  }
  if (op === "ping") return json({ ok: true });
  return json({ error: "unknown_op" }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const url = new URL(req.url);

  if (url.pathname.endsWith("/webhook")) {
    if (!FLW_SECRET_HASH || req.headers.get("verif-hash") !== FLW_SECRET_HASH) return json({ error: "unauthorized" }, 401);
    const evt = await req.json().catch(() => null);
    const txRef = evt?.data?.tx_ref; const txId = evt?.data?.id;
    if (!txRef || !txId || !FLW_SECRET_KEY) return json({ ok: true });
    const baseRef = String(txRef).split("-").slice(0, 2).join("-");
    const { data: row } = await db.from("epms_submissions").select("*").eq("tx_ref", baseRef).maybeSingle();
    if (row) await reconcile(row, String(txId));
    return json({ ok: true });
  }

  const raw = await req.text();
  if (raw.length > MAX_BYTES) return json({ error: "too_large" }, 413);
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400); }
  const action = body?.action;

  if (action === "admin") return await admin(req, body);

  if (action === "config") {
    return json({ price: PRICE, currency: CURRENCY, payments_ready: Boolean(FLW_SECRET_KEY) });
  }

  if (action === "save") {
    const data = body.data;
    if (!data || typeof data !== "object" || data.form !== "UCH-EPMS-DETAILS") return json({ error: "bad_data" }, 400);
    // keep only well-formed, approved PNG signatures; the supervisor's and counter-signer's also need the nurse's
    // confirmation that the signer agreed. Anything else is dropped.
    for (const f of SIG_FIELDS) {
      const sig = data[f];
      const ok = sig && typeof sig === "object" && sig.approved === true && typeof sig.png === "string" &&
        sig.png.length <= MAX_SIG && /^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(sig.png) &&
        (f === "signature" || sig.consent === true);
      data[f] = ok ? (f === "signature" ? { png: sig.png, approved: true } : { png: sig.png, approved: true, consent: true }) : null;
    }
    const fields = { ...summary(data), data };
    if (body.token) {
      if (!UUID.test(body.token)) return json({ error: "bad_token" }, 400);
      const { data: row, error } = await db.from("epms_submissions").update(fields)
        .eq("edit_token", body.token).select("edit_token, tx_ref, payment_status").maybeSingle();
      if (error) return json({ error: "db_error" }, 500);
      if (!row) return json({ error: "not_found" }, 404);
      return json({ token: row.edit_token, tx_ref: row.tx_ref, payment_status: row.payment_status });
    }
    const { data: row, error } = await db.from("epms_submissions").insert(fields)
      .select("edit_token, tx_ref, payment_status").single();
    if (error) return json({ error: "db_error" }, 500);
    return json({ token: row.edit_token, tx_ref: row.tx_ref, payment_status: row.payment_status });
  }

  if (action === "start") {
    if (!UUID.test(body.token ?? "")) return json({ error: "bad_token" }, 400);
    const row = await rowByToken(body.token);
    if (!row) return json({ error: "not_found" }, 404);
    if (!belongsTo(row, body.attempt_ref) || String(body.attempt_ref).length > 80) return json({ error: "bad_ref" }, 400);
    const hist = [...(Array.isArray(row.tx_refs) ? row.tx_refs : []), body.attempt_ref].slice(-30);
    await db.from("epms_submissions").update({ last_tx_ref: body.attempt_ref, tx_refs: hist }).eq("id", row.id);
    return json({ ok: true });
  }

  if (action === "load") {
    if (!UUID.test(body.token ?? "")) return json({ error: "bad_token" }, 400);
    const row = await rowByToken(body.token);
    if (!row) return json({ error: "not_found" }, 404);
    let status = row.payment_status;
    if (status !== "paid" && (row.last_tx_ref || row.email)) {
      if ((await reconcile(row)).paid) status = "paid";
    }
    return json({ data: row.data, tx_ref: row.tx_ref, payment_status: status, updated_at: row.updated_at });
  }

  if (action === "verify" || action === "check") {
    if (!FLW_SECRET_KEY) return json({ error: "payments_not_configured" }, 503);
    if (!UUID.test(body.token ?? "")) return json({ error: "bad_request" }, 400);
    const row = await rowByToken(body.token);
    if (!row) return json({ error: "not_found" }, 404);
    if (row.payment_status === "paid") return json({ payment_status: "paid" });
    const r = await reconcile(row, body.transaction_id ? String(body.transaction_id) : undefined);
    return json({ payment_status: r.paid ? "paid" : "unpaid" });
  }

  return json({ error: "unknown_action" }, 400);
});
