// The workbook builder: a GitHub Actions job in this repository (and nothing else) asks which nurses need a workbook,
// builds them, and uploads the files to private storage. It proves who it is with GitHub's own signed OIDC token,
// so no password or key lives in the public repository.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("EPMS_ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`));
const REPO = "buildnet6/uch-epms-form";
const WORKFLOW = `${REPO}/.github/workflows/build-workbooks.yml@`;
const AUDIENCE = "epms-builder";
const BUCKET = "epms-workbooks";
const SIG_FIELDS = ["signature", "supervisor_signature", "cso_signature"];
const FILE_NAME = /^[A-Za-z0-9_.-]{1,120}\.(xlsx|pdf)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

async function runner(req: Request) {
  const token = req.headers.get("x-gh-oidc") ?? "";
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER, audience: AUDIENCE });
    if (payload.repository !== REPO || payload.ref !== "refs/heads/main") return null;
    if (!String(payload.workflow_ref ?? "").startsWith(WORKFLOW)) return null;
    if (!["schedule", "workflow_dispatch", "push"].includes(String(payload.event_name))) return null;
    return payload;
  } catch {
    return null;
  }
}

// a form is ready when all 12 months have results and no chosen task is missing its result
function formComplete(data: any) {
  const months = Array.isArray(data?.monthly) ? data.monthly.slice(0, 12) : [];
  if (months.length < 12) return false;
  return months.every((m: any) => {
    const rows = (Array.isArray(m?.rows) ? m.rows : []).filter((r: any) => r && String(r.kra ?? "").trim());
    return rows.length > 0 && rows.every((r: any) => String(r.output ?? "").trim() !== "");
  });
}

const T = (s: unknown) => (s ? new Date(String(s)).getTime() : 0);

function needsBuild(r: any) {
  if (r.archived || r.is_test) return false;
  if (!(r.payment_status === "paid" || r.complimentary)) return false;
  if (!formComplete(r.data)) return false;
  const built = T(r.built_at);
  const last = Math.max(T(r.data_updated_at), T(r.build_requested_at));
  if (built && last <= built) return false;
  // a failed build waits for a change or an explicit rebuild instead of retrying every few minutes
  if (T(r.build_failed_at) >= last && T(r.build_failed_at) > built) return false;
  return true;
}

async function builderRoute(req: Request, body: any) {
  if (!(await runner(req))) return json({ error: "unauthorized" }, 401);
  const op = body?.op;
  const id = typeof body?.id === "string" && UUID.test(body.id) ? body.id : null;

  if (op === "jobs") {
    const { data: rows, error } = await db.from("epms_submissions")
      .select("id, payment_status, complimentary, archived, is_test, data_updated_at, built_at, build_requested_at, build_failed_at, data")
      .or("payment_status.eq.paid,complimentary.eq.true");
    if (error) return json({ error: "db" }, 500);
    return json({ jobs: (rows ?? []).filter(needsBuild).map((r: any) => r.id) });
  }
  if (op === "get" && id) {
    const { data: row } = await db.from("epms_submissions").select("id, data").eq("id", id).maybeSingle();
    if (!row) return json({ error: "not_found" }, 404);
    return json({ data: row.data, started_at: new Date().toISOString() });
  }
  if (op === "put_file" && id) {
    const name = String(body.name ?? "");
    const ext = name.split(".").pop() ?? "";
    if (!FILE_NAME.test(name) || typeof body.b64 !== "string") return json({ error: "bad_file" }, 400);
    const bytes = Uint8Array.from(atob(body.b64), (c) => c.charCodeAt(0));
    const { error } = await db.storage.from(BUCKET).upload(`${id}/${name}`, bytes, { contentType: MIME[ext], upsert: true });
    if (error) return json({ error: "upload_failed" }, 500);
    return json({ ok: true });
  }
  if (op === "done" && id) {
    const files = (Array.isArray(body.files) ? body.files : []).filter((n: unknown) => typeof n === "string" && FILE_NAME.test(n));
    const started = body.started_at && !isNaN(T(body.started_at)) ? new Date(String(body.started_at)).toISOString() : new Date().toISOString();
    const { data: row } = await db.from("epms_submissions").select("first_name, surname, build_files").eq("id", id).maybeSingle();
    // drop files from an earlier build that this build no longer produces (e.g. after a name change)
    const stale = (Array.isArray(row?.build_files) ? row.build_files : []).filter((n: string) => !files.includes(n));
    if (stale.length) await db.storage.from(BUCKET).remove(stale.map((n: string) => `${id}/${n}`));
    await db.from("epms_submissions").update({
      built_at: started, build_files: files, build_report: body.report ?? null, build_error: null, build_failed_at: null,
      filled_at: new Date().toISOString(),
    }).eq("id", id);
    const who = [row?.first_name, row?.surname].filter(Boolean).join(" ") || "a nurse";
    const flags = Array.isArray(body.report?.flags) ? body.report.flags.length : 0;
    await db.from("epms_events").insert({ submission_id: id, kind: "admin",
      detail: `Workbook built automatically for ${who}` + (flags ? ` (${flags} thing${flags > 1 ? "s" : ""} to check)` : "") });
    return json({ ok: true });
  }
  if (op === "fail" && id) {
    await db.from("epms_submissions").update({ build_failed_at: new Date().toISOString(), build_error: String(body.error ?? "").slice(0, 300) }).eq("id", id);
    return json({ ok: true });
  }
  if (op === "secret") {
    const name = String(body.name ?? "");
    const { data } = await db.from("epms_private").select("value").eq("name", name).maybeSingle();
    return json({ value: data?.value ?? null });
  }
  if (op === "set_signature" && id) {
    const field = String(body.field ?? "");
    const png = String(body.png ?? "");
    if (!SIG_FIELDS.includes(field) || !png.startsWith("data:image/png;base64,") || png.length > 400_000) return json({ error: "bad_signature" }, 400);
    const { data: row } = await db.from("epms_submissions").select("data").eq("id", id).maybeSingle();
    if (!row) return json({ error: "not_found" }, 404);
    if (row.data?.[field]?.png === png) return json({ ok: true, unchanged: true });
    const data = { ...row.data, [field]: { png, approved: true, consent: true, supplied_by: "admin" } };
    await db.from("epms_submissions").update({ data }).eq("id", id);
    return json({ ok: true });
  }
  return json({ error: "unknown_op" }, 400);
}

// dashboard: time-limited links to one nurse's built files
async function signedFiles(id: string) {
  const { data: row } = await db.from("epms_submissions").select("build_files, built_at, build_report, build_error, build_failed_at, build_requested_at").eq("id", id).maybeSingle();
  const names: string[] = Array.isArray(row?.build_files) ? row.build_files : [];
  const files = [];
  for (const n of names) {
    const path = `${id}/${n}`;
    const view = await db.storage.from(BUCKET).createSignedUrl(path, 3600);
    const dl = await db.storage.from(BUCKET).createSignedUrl(path, 3600, { download: n });
    if (view.data?.signedUrl) files.push({ name: n, view: view.data.signedUrl, download: dl.data?.signedUrl ?? view.data.signedUrl });
  }
  return { files, built_at: row?.built_at ?? null, report: row?.build_report ?? null, error: row?.build_error ?? null,
           failed_at: row?.build_failed_at ?? null, requested_at: row?.build_requested_at ?? null };
}

// ---------- admin (same passcode as the dashboard; checked against the same hash and lockout) ----------
const unb64 = (x: string) => Uint8Array.from(atob(x), (c) => c.charCodeAt(0));
async function pbkdf2(pass: string, salt: Uint8Array, iter: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
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

async function adminRoute(req: Request, body: any) {
  const auth = await adminOk(body.key, clientIp(req));
  if (auth === "locked") return json({ error: "locked" }, 429);
  if (!auth) return json({ error: "wrong_passcode" }, 401);
  const id = typeof body.id === "string" && UUID.test(body.id) ? body.id : null;
  if (body.op === "status") {
    // build state for every nurse, for the dashboard list
    const { data: rows } = await db.from("epms_submissions")
      .select("id, payment_status, complimentary, archived, is_test, data_updated_at, built_at, build_requested_at, build_failed_at, build_error, build_report, data");
    const out: Record<string, unknown> = {};
    for (const r of rows ?? []) {
      out[r.id] = { built_at: r.built_at, failed_at: r.build_failed_at, error: r.build_error, requested_at: r.build_requested_at,
                    flags: r.build_report?.flags ?? [], quarters: r.build_report?.quarters ?? null,
                    met: r.build_report?.results_met ?? null, total: r.build_report?.results_total ?? null,
                    complete: formComplete(r.data), queued: needsBuild(r) };
    }
    return json({ status: out });
  }
  if (body.op === "files" && id) return json(await signedFiles(id));
  if (body.op === "rebuild" && id) {
    await db.from("epms_submissions").update({ build_requested_at: new Date().toISOString(), build_failed_at: null, build_error: null }).eq("id", id);
    return json({ ok: true });
  }
  return json({ error: "unknown_op" }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const raw = await req.text();
  if (raw.length > 12_000_000) return json({ error: "too_large" }, 413);
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400); }
  if (req.headers.get("x-gh-oidc")) return await builderRoute(req, body);
  if (body?.action === "admin") return await adminRoute(req, body);
  return json({ error: "unknown_action" }, 400);
});
