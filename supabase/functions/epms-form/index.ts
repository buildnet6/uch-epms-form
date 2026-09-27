// EPMS details form backend
// - save:   create or update a nurse's submission (identified by a private edit token)
// - load:   fetch a submission by edit token (for the edit link)
// - verify: confirm a Flutterwave payment server-side and mark the submission paid
// - config: price and whether payments are switched on
// - /webhook: Flutterwave webhook (backup confirmation if the browser closes early)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const PRICE = Number(Deno.env.get("EPMS_PRICE") ?? "12400");
const CURRENCY = "NGN";
const FLW_SECRET_KEY = Deno.env.get("FLW_SECRET_KEY") ?? "";
const FLW_SECRET_HASH = Deno.env.get("FLW_SECRET_HASH") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("EPMS_ALLOWED_ORIGIN") ?? "*";
const MAX_BYTES = 200_000;
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

async function flwVerify(transactionId: string) {
  const r = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`, {
    headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` },
  });
  const body = await r.json().catch(() => ({}));
  return body?.data ?? null;
}

async function markPaidIfValid(row: any, tx: any) {
  if (!tx) return { ok: false, reason: "not_found" };
  const refOk = typeof tx.tx_ref === "string" && (tx.tx_ref === row.tx_ref || tx.tx_ref.startsWith(row.tx_ref + "-"));
  const good = tx.status === "successful" && refOk &&
    tx.currency === CURRENCY && Number(tx.amount) >= PRICE;
  if (!good) return { ok: false, reason: "not_successful" };
  if (row.payment_status !== "paid") {
    const { error } = await db.from("epms_submissions").update({
      payment_status: "paid", amount_paid: tx.amount, currency: tx.currency,
      flw_transaction_id: String(tx.id), paid_at: new Date().toISOString(),
    }).eq("id", row.id);
    if (error) return { ok: false, reason: "db_error" };
  }
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const url = new URL(req.url);

  // ---- Flutterwave webhook ----
  if (url.pathname.endsWith("/webhook")) {
    if (!FLW_SECRET_HASH || req.headers.get("verif-hash") !== FLW_SECRET_HASH) return json({ error: "unauthorized" }, 401);
    const evt = await req.json().catch(() => null);
    const txRef = evt?.data?.tx_ref; const txId = evt?.data?.id;
    if (!txRef || !txId || !FLW_SECRET_KEY) return json({ ok: true });
    const baseRef = String(txRef).split("-").slice(0, 2).join("-");  // UCHEPMS25-<id>-<attempt> -> UCHEPMS25-<id>
    const { data: row } = await db.from("epms_submissions").select("*").eq("tx_ref", baseRef).maybeSingle();
    if (row) await markPaidIfValid(row, await flwVerify(String(txId)));  // never trust the webhook body alone
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

  if (action === "load") {
    if (!UUID.test(body.token ?? "")) return json({ error: "bad_token" }, 400);
    const { data: row } = await db.from("epms_submissions")
      .select("data, tx_ref, payment_status, updated_at").eq("edit_token", body.token).maybeSingle();
    if (!row) return json({ error: "not_found" }, 404);
    return json(row);
  }

  if (action === "verify") {
    if (!FLW_SECRET_KEY) return json({ error: "payments_not_configured" }, 503);
    if (!UUID.test(body.token ?? "") || !body.transaction_id) return json({ error: "bad_request" }, 400);
    const { data: row } = await db.from("epms_submissions").select("*").eq("edit_token", body.token).maybeSingle();
    if (!row) return json({ error: "not_found" }, 404);
    if (row.payment_status === "paid") return json({ payment_status: "paid" });
    const res = await markPaidIfValid(row, await flwVerify(String(body.transaction_id)));
    return json({ payment_status: res.ok ? "paid" : "unpaid", reason: res.ok ? undefined : res.reason });
  }

  return json({ error: "unknown_action" }, 400);
});
