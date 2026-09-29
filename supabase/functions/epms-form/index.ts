// UCH Nurses EPMS form backend
// - config:  price and whether payments are switched on
// - save:    create or update a nurse's submission (identified by a private edit token);
//            optional approved signatures (nurse, supervisor, counter-signing officer; small PNGs) travel inside it
// - load:    fetch a submission by edit token (also re-checks an unconfirmed payment)
// - start:   record the reference of a payment attempt just before checkout opens
// - verify / check: confirm a Flutterwave payment server-side and mark the submission paid
// - /webhook: optional Flutterwave webhook (not used while the Flutterwave account is shared)
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
      flw_transaction_id: String(tx.id), paid_at: new Date().toISOString(),
    }).eq("id", row.id);
    if (error) return { ok: false, reason: "db_error" };
  }
  return { ok: true };
}

// Look for a successful payment for this submission in every way we can:
// 1) the transaction id the checkout returned, 2) the last attempt's reference,
// 3) recent successful payments from the nurse's email carrying this submission's reference.
async function reconcile(row: any, transactionId?: string) {
  if (!FLW_SECRET_KEY) return false;
  if (row.payment_status === "paid") return true;
  await db.from("epms_submissions").update({ last_checked_at: new Date().toISOString() }).eq("id", row.id);
  if (transactionId) {
    const v = await flwGet(`/transactions/${encodeURIComponent(transactionId)}/verify`);
    if ((await markPaidIfValid(row, v?.data)).ok) return true;
  }
  if (row.last_tx_ref) {
    const v = await flwGet(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(row.last_tx_ref)}`);
    if ((await markPaidIfValid(row, v?.data)).ok) return true;
  }
  if (row.email) {
    const from = new Date(new Date(row.created_at).getTime() - 86_400_000).toISOString().slice(0, 10);
    const list = await flwGet(`/transactions?customer_email=${encodeURIComponent(row.email)}&status=successful&from=${from}`);
    for (const t of (list?.data ?? [])) {
      if (belongsTo(row, t?.tx_ref)) {
        const v = await flwGet(`/transactions/${encodeURIComponent(String(t.id))}/verify`);  // never trust a list entry alone
        if ((await markPaidIfValid(row, v?.data)).ok) return true;
      }
    }
  }
  return false;
}

async function rowByToken(token: string) {
  const { data } = await db.from("epms_submissions").select("*").eq("edit_token", token).maybeSingle();
  return data;
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
    await db.from("epms_submissions").update({ last_tx_ref: body.attempt_ref }).eq("id", row.id);
    return json({ ok: true });
  }

  if (action === "load") {
    if (!UUID.test(body.token ?? "")) return json({ error: "bad_token" }, 400);
    const row = await rowByToken(body.token);
    if (!row) return json({ error: "not_found" }, 404);
    let status = row.payment_status;
    if (status !== "paid" && (row.last_tx_ref || row.email)) {
      if (await reconcile(row)) status = "paid";
    }
    return json({ data: row.data, tx_ref: row.tx_ref, payment_status: status, updated_at: row.updated_at });
  }

  if (action === "verify" || action === "check") {
    if (!FLW_SECRET_KEY) return json({ error: "payments_not_configured" }, 503);
    if (!UUID.test(body.token ?? "")) return json({ error: "bad_request" }, 400);
    const row = await rowByToken(body.token);
    if (!row) return json({ error: "not_found" }, 404);
    if (row.payment_status === "paid") return json({ payment_status: "paid" });
    const ok = await reconcile(row, body.transaction_id ? String(body.transaction_id) : undefined);
    return json({ payment_status: ok ? "paid" : "unpaid" });
  }

  return json({ error: "unknown_action" }, 400);
});
