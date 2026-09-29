// Auto-complete a nurse's EPMS answers from the tasks (KRAs) she chose.
//
// Fills ONLY what is empty. Anything the nurse typed stays exactly as she typed it.
// - months with no tasks get 2-3 of her own tasks, rotated so every task she chose shows up in the year and no
//   quarter carries more than 6 different tasks (the quarterly appraisal page holds 6);
// - chosen tasks with no result get a result that fits the task's own target and scale from the master contract
//   (mostly at or a little above target, now and then just below, never an impossible value);
// - every filled row gets an issue written for that kind of task and her ward, in her own words where she used
//   some (e.g. "Shortage of personnel"), never the same line for the same task two months running;
// - empty "about your year" answers are written from her tasks, her unit and the problems she reported.
// Priority details (her name, IPPIS, contacts, supervisor, counter-signer) are never invented: they are reported.
// Deterministic: the same nurse always gets the same fill, so re-running changes nothing.
import { SCALE_H } from "./scale.ts";

type Row = { kra: string; code: string; output: string; issues: string; auto?: boolean };
type Task = { code: string; kra: string; custom?: any };
type Scale = { kind: string; target: number | null; lower: boolean; frac?: boolean };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const EXTRA_KEYS = ["outstanding_performance", "areas_of_improvement", "training_needs", "future_goals", "other_feedback"];

// ---------- deterministic randomness ----------
function hash(s: string) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed: string) { let a = hash(seed); return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pickN = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

// ---------- task knowledge ----------
const norm = (s: string) => String(s || "").replace(/\s+/g, " ").trim();
const key = (t: { code: string; kra: string }) => `${norm(t.code)}|${norm(t.kra)}`;
function scaleOf(t: Task): Scale | null {
  const h = SCALE_H[hash(key(t)).toString(16)];
  if (h) { const [k, tg, lo, fr] = h.split(","); return { kind: k === "p" ? "pct" : k === "c" ? "count" : "min", target: tg === "" ? null : Number(tg), lower: lo === "1", frac: fr === "1" }; }
  const c = t.custom;                                     // a nurse's own task (not in the master)
  if (c && c.target !== undefined && c.target !== "") {
    const n = Number(String(c.target).replace(/[^\d.]/g, ""));
    const unit = String(c.unit || "").trim();
    if (Number.isFinite(n)) return unit === "%" ? { kind: "pct", target: n <= 1 ? n * 100 : n, lower: false, frac: n <= 1 }
      : /min/i.test(unit) ? { kind: "min", target: n, lower: true } : { kind: "count", target: n, lower: false };
  }
  return null;
}

const CATS: [string, RegExp][] = [
  ["care", /prompt response|patients? needs?\b/i],
  ["rounds", /wards? ?rounds|multidisciplinary/i],
  ["palliative", /palliat|paliat|morphine|pain|nausea|dyspnoea|symptom/i],
  ["students", /student|placement|clinical posting|practice sites|osce|clinical teaching|bedside teaching/i],
  ["theatre", /theatre|surgical|surger|operating|peri-?operative|pre-?operative/i],
  ["training", /training|train |capacity building|study.?block|induction|mentor|sop/i],
  ["hygiene", /hand hygiene|tidying|bedside and environment/i],
  ["disinfection", /disinfect|steril|wash-down|decontam|deratiz|disinfest|cleaning/i],
  ["delivery", /deliver(y|ies) of babies|antenatal|\banc\b|\bpnc\b|mothers/i],
  ["healthtalk", /health talk|health information|awareness|media|sms|enlightenment|education session|rall/i],
  ["records", /documentation|document|record|register|report|dashboard|\becm\b|memo|statistic/i],
  ["emergency", /emergen|critically ill|triage|bed management|admission|transfer/i],
  ["clinic", /out-?patient|\bclinics?\b|appointment|scheduling|wait time|consult/i],
  ["admin", /pms|promotion|committee|administrative|appraisal|polic|recruit|staff profile|collaboration/i],
  ["equipment", /equipment|maintenance/i],
  ["outreach", /outreach|screening|signage/i],
  ["care", /prompt response|patients? need|nursing care|service delivery|care/i],
];
const catOf = (kra: string) => (CATS.find(([, re]) => re.test(kra)) || ["care"])[0];

// cause sentences per kind of task; {pt} = patients/children, {fam} = relatives/caregivers, {place} = ward/unit
const CAUSES: Record<string, string[]> = {
  palliative: ["Delays in getting palliative care reviews for some newly diagnosed {pt}.", "Morphine and other analgesics were sometimes out of stock in the pharmacy.",
    "Some {fam} were reluctant to accept palliative care referral at first.", "Pain scores were not charted on every shift."],
  theatre: ["Late arrival of {pt} to theatre and delayed pre-operative preparation.", "Some elective cases were cancelled on the day of surgery.",
    "Emergency cases disrupted the elective list.", "Delays in theatre turnover between cases."],
  students: ["Large student groups on the ward at the same time.", "Clinical teaching sessions clashed with heavy ward work.",
    "Delays in releasing students' posting schedules.", "Limited space and equipment for skills demonstrations."],
  training: ["Staff shift schedules clashed with training sessions.", "Limited training materials and venue for in-service training.",
    "Some staff could not attend because of heavy ward duties.", "Delays in approval of study-block dates."],
  hygiene: ["Shortage of hand-rub, liquid soap and paper towels at times.", "Irregular water supply at some hand-washing points.",
    "High turnover of {fam} at the bedside made tidiness harder to keep.", "Some new staff needed reminders on hand hygiene moments."],
  disinfection: ["Shortage of disinfectants and cleaning agents at times.", "Autoclave downtime delayed some sterilization cycles.",
    "Cleaning schedules were disrupted during busy periods.", "Irregular water supply affected wash-down days."],
  delivery: ["Late booking of some mothers for antenatal care.", "Some mothers missed their appointment days.",
    "Shortage of delivery packs and consumables at times.", "Crowded antenatal clinic days reduced time for each mother."],
  healthtalk: ["Some {fam} left before the health talk ended because of long clinic waits.", "Limited IEC materials and public-address equipment.",
    "Noise and limited space in the waiting area.", "Delays in getting media and venue approvals."],
  emergency: ["Bed shortage delayed admission of some {pt}.", "Delays in reviewing critically ill {pt} during night shifts.",
    "Late submission of bed returns from some units.", "Transfers were delayed by lack of beds on specialty wards."],
  clinic: ["Clinic overcrowding on some days.", "Some {pt} came without appointments.",
    "Delays in retrieving case notes from records.", "Doctors were sometimes late to clinic."],
  rounds: ["Some members of the team could not join every round.", "Rounds were cut short on very busy days.",
    "Delays in getting feedback from other disciplines."],
  records: ["Incomplete entries during peak hours.", "Network downtime slowed digital record updates.",
    "Shortage of standard forms and registers at times.", "Late submission of reports from some units."],
  admin: ["Late submission of documents by some staff.", "Network downtime affected the online process.",
    "Delays in feedback from management.", "Heavy clinical duties limited time for administrative work."],
  equipment: ["Delayed response from vendors for spare parts.", "Ageing equipment broke down between maintenance checks.",
    "Voltage fluctuation damaged some equipment."],
  outreach: ["Limited funding and transport for outreach activities.", "Some signs were removed or defaced and needed replacement.",
    "Delays in approval for outreach dates."],
  care: ["High patient load at peak hours slowed response.", "Delays in getting some investigation results back.",
    "Some {fam} needed repeated counselling before consenting to care.", "Frequent emergencies stretched the available staff."],
};
const RESOURCES = ["Shortage of personnel.", "High patient load.", "Shortage of consumables.", "Poor power supply.", "Equipment breakdown.", "Network downtime."];
const RES_WORDS: [RegExp, string][] = [[/shortage of (personnel|manpower|staff)|few(er)? (nurses|staff)/i, "Shortage of personnel."], [/patient load|overcrowd/i, "High patient load."],
  [/consumable/i, "Shortage of consumables."], [/power|electric/i, "Poor power supply."], [/equipment|breakdown/i, "Equipment breakdown."], [/network|internet/i, "Network downtime."]];

// ---------- results ----------
const trim = (x: number) => String(Math.round(x * 100) / 100);
function result(s: Scale | null, r: () => number, below: boolean): { value: string; met: boolean } | null {
  if (!s || s.target === null || s.target === undefined) return null;
  const t = Number(s.target);
  if (s.kind === "pct" && !s.lower) {
    let v: number;
    if (t >= 100) v = below ? pickN(r, 95, 98) : 100;
    else if (t >= 90) v = below ? pickN(r, t - 3, t - 1) : pickN(r, t, Math.min(100, t + 4));
    else if (t >= 30) v = below ? pickN(r, t - 4, t - 1) : pickN(r, t, Math.min(100, t + 6));
    else v = below ? Math.max(1, t - pickN(r, 1, 2)) : pickN(r, t, t + 3);
    return { value: s.frac ? trim(v / 100) : String(v), met: v >= t };
  }
  if (s.lower) {                                          // lower is better (waiting minutes, error counts)
    if (t <= 0) return { value: "0", met: true };
    const v = below ? t + pickN(r, 2, 5) : Math.max(1, t - pickN(r, 0, Math.max(1, Math.round(t * 0.15))));
    return { value: s.kind === "pct" && s.frac ? trim(v / 100) : String(v), met: v <= t };
  }
  if (s.kind === "count") {
    let v: number;
    if (t >= 1000) v = Math.round(t * (below ? 0.93 + r() * 0.05 : 1 + r() * 0.06));
    else if (t > 4) v = below ? t - pickN(r, 1, 2) : t + pickN(r, 0, 2);
    else v = below ? Math.max(0, t - 1) : (r() < 0.2 ? t + 1 : t);
    return { value: String(v), met: v >= t };
  }
  return { value: String(t), met: true };
}

// ---------- helpers for "about your year" ----------
function plain(kra: string) {
  let s = norm(kra).replace(/^\d+[.)]\s*/, "").replace(/^(to |ensure |provide,? )/i, "");
  s = s.split(/[,;:.]| through | by | in line with | and ensure /i)[0].trim();
  if (s.length > 55) s = s.slice(0, 55).replace(/\s+\S*$/, "");
  let prev = "";
  while (prev !== s) { prev = s; s = s.replace(/\s+(and|of|the|with|to|for|in|on|at|a|an|up|&)$/i, "").replace(/[\s,;:'’-]+$/, ""); }
  return s.charAt(0).toLowerCase() + s.slice(1);
}
const TRAINING: Record<string, string> = {
  palliative: "Paediatric palliative care and pain management training.", theatre: "Perioperative nursing and theatre infection prevention training.",
  students: "Clinical teaching, mentoring and OSCE assessment training.", emergency: "Emergency and critical care nursing update.",
  delivery: "Midwifery and emergency obstetric care update.", healthtalk: "Health communication and patient education skills.",
  records: "Digital records (ECM) and report writing training.", admin: "Leadership and management training for nurse managers.",
};
const IMPROVE: Record<string, string> = {
  "Shortage of personnel.": "Recruitment of more nurses to match the patient load", "High patient load.": "More beds and equipment for the patient load",
  "Shortage of consumables.": "Regular supply of consumables", "Poor power supply.": "Steady power supply", "Equipment breakdown.": "Prompt repair and replacement of equipment",
  "Network downtime.": "Stable network for digital records",
};

export type AutofillReport = {
  changed: boolean; months_filled: string[]; rows_added: number; results_filled: number; issues_written: number;
  duplicates_removed: number; extras_filled: string[]; tasks_not_used: string[]; missing_priority: string[]; note?: string;
};

export function autofill(data: any): { data: any; report: AutofillReport } {
  const d = JSON.parse(JSON.stringify(data || {}));
  const rep: AutofillReport = { changed: false, months_filled: [], rows_added: 0, results_filled: 0, issues_written: 0, duplicates_removed: 0,
    extras_filled: [], tasks_not_used: [], missing_priority: [] };
  const emp = d.employee || {}, sup = d.supervisor || {}, cso = d.countersigning_officer || {};

  // priority details: reported, never invented
  const need = (o: any, f: string, label: string) => { if (!String(o?.[f] || "").trim()) rep.missing_priority.push(label); };
  need(emp, "surname", "her surname"); need(emp, "first_name", "her first name"); need(emp, "designation", "her designation");
  need(emp, "ippis", "her IPPIS number"); need(emp, "phone", "her phone number"); need(emp, "email", "her email"); need(emp, "unit", "her ward/unit");
  need(sup, "surname", "supervisor's surname"); need(sup, "designation", "supervisor's designation");
  need(cso, "surname", "counter-signer's surname"); need(cso, "designation", "counter-signer's designation");
  if (sup.surname && ((sup.ippis && sup.ippis === emp.ippis) ||
      (norm(sup.surname).toLowerCase() === norm(emp.surname).toLowerCase() && norm(sup.first_name).toLowerCase() === norm(emp.first_name).toLowerCase())))
    rep.missing_priority.push("her real supervisor (she entered herself)");

  // her tasks, without repeats
  const seen = new Set<string>();
  const tasks: Task[] = (d.kras || []).filter((k: any) => k && k.kra).map((k: any) => ({ code: String(k.code || ""), kra: String(k.kra), custom: k.custom }))
    .filter((t: Task) => { const k = key(t); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!tasks.length) { rep.note = "She hasn't chosen any tasks yet, so there is nothing to fill from."; return { data: d, report: rep }; }
  const byKey = new Map(tasks.map((t) => [key(t), t]));

  const seed = [emp.ippis, emp.surname, emp.first_name].join("|");
  const r = rng(seed);
  const unit = norm(emp.unit).replace(/\(\s*([^()]*?)\s*\(*\s*$/, " ($1)").replace(/\(\s*\)/g, "").replace(/\s+\(/g, " (").replace(/\s+/g, " ").trim();
  const kids = /paed|child|otchew|neonat|nicu|sick baby/i.test(unit) || tasks.some((t) => /PAED/i.test(t.code));
  const fill = (s: string) => s.replace(/\{pt\}/g, kids ? "children" : "patients").replace(/\{fam\}/g, kids ? "caregivers" : "relatives").replace(/\{place\}/g, unit || "the ward");

  // her own words for problems, used first
  const mine: string[] = [];
  const months = MONTHS.map((m, i) => {
    const src = (d.monthly || []).find((x: any) => x && x.month === m) || (d.monthly || [])[i] || { month: m, rows: [] };
    return { ...src, month: m, rows: (src.rows || []).filter((x: any) => x && (x.kra || x.output || x.issues)).map((x: any) => ({ ...x })) as Row[] };
  });
  months.forEach((m) => m.rows.forEach((x) => RES_WORDS.forEach(([re, label]) => { if (re.test(x.issues || "") && !mine.includes(label)) mine.push(label); })));
  const resources = [...mine, ...RESOURCES.filter((x) => !mine.includes(x))];

  // drop a task repeated in the same month (keep the first, or the one with a result)
  months.forEach((m) => {
    const keep: Row[] = [];
    m.rows.forEach((x) => {
      if (!x.kra) return keep.push(x);
      const i = keep.findIndex((y) => y.kra && key(y) === key(x));
      if (i < 0) return keep.push(x);
      rep.duplicates_removed++;
      if (!String(keep[i].output || "").trim() && String(x.output || "").trim()) keep[i] = x;
    });
    m.rows = keep;
  });

  // how much each task matters to her: used by her > matches her unit > the rest
  const used = new Map<string, number>();
  months.forEach((m) => m.rows.forEach((x) => { if (x.kra) used.set(key(x), (used.get(key(x)) || 0) + 1); }));
  const unitRe: [RegExp, RegExp][] = [[/paed|child|otchew|neonat/i, /PAED|child|babies|mothers/i], [/theatre|surg/i, /SURG|theatre|steril|PERI/i],
    [/eye|ophthal/i, /OPHTHAL|eye/i], [/emergen|a ?& ?e|casualty/i, /ED0|emergen|critically/i], [/psych|neuro|mental/i, /PSY|mental|CLIPSY|NEU/i],
    [/labour|antenatal|maternity|o ?& ?g/i, /O & G|mothers|babies|antenatal/i], [/school|nursing education/i, /student|SON|SOM|SOHN|PERI|NURSED/i]];
  const weight = (t: Task) => (used.has(key(t)) ? 3 : 0) + (unitRe.some(([u, k]) => u.test(unit) && k.test(t.code + " " + t.kra)) ? 2 : 0) + 1;
  const order = [...tasks].sort((a, b) => weight(b) - weight(a) || tasks.indexOf(a) - tasks.indexOf(b));

  // an empty month gets 3 of her tasks (2 if she chose only a few); a month with 1 task is topped up to 2;
  // a month where she already entered 2 or more is left as she made it
  const perMonth = tasks.length >= 6 ? 3 : Math.min(2, tasks.length);
  const minKeep = Math.min(2, tasks.length);
  const n = tasks.length;
  const coreN = Math.max(0, Math.min(2, Math.floor((24 - n) / 4)));        // repeats allowed only while every task still fits in the year
  const qSize = Math.min(6, n, Math.max(perMonth + 1, Math.ceil(n / 4) + coreN));
  const yearUse = new Map<string, number>();
  months.forEach((m) => m.rows.forEach((x) => { if (x.kra) yearUse.set(key(x), (yearUse.get(key(x)) || 0) + 1); }));
  let cursor = 0;
  const core = order.filter((t) => used.has(key(t))).slice(0, coreN);   // the tasks she used herself come back every quarter

  for (let q = 0; q < 4; q++) {
    const qm = months.slice(q * 3, q * 3 + 3);
    const set: string[] = [];
    const add = (k: string) => { if (set.length < 6 && !set.includes(k)) set.push(k); };
    qm.forEach((m) => m.rows.forEach((x) => { if (x.kra) add(key(x)); }));
    const target = (m: any) => { const h = m.rows.filter((x: Row) => x.kra).length; return h === 0 ? perMonth : h < minKeep ? minKeep : h; };
    const needsFill = qm.some((m) => m.rows.filter((x) => x.kra).length < target(m));
    if (needsFill) {
      core.forEach((t) => { if (set.length < qSize) add(key(t)); });
      let guard = 0;
      while (set.length < qSize && guard++ < order.length * 2) { add(key(order[cursor % order.length])); cursor++; }
    }
    const qUse = new Map<string, number>();
    qm.forEach((m) => m.rows.forEach((x) => { if (x.kra) qUse.set(key(x), (qUse.get(key(x)) || 0) + 1); }));
    qm.forEach((m) => {
      const had = m.rows.filter((x) => x.kra).length;
      const want = target(m);
      if (had >= want) return;
      const inMonth = new Set(m.rows.filter((x) => x.kra).map((x) => key(x)));
      const cands = set.filter((k) => !inMonth.has(k)).sort((a, b) => (qUse.get(a) || 0) - (qUse.get(b) || 0) || (yearUse.get(a) || 0) - (yearUse.get(b) || 0));
      m.rows = m.rows.filter((x) => x.kra || x.output || x.issues);
      for (const k of cands.slice(0, want - had)) {
        const t = byKey.get(k)!;
        m.rows.push({ kra: t.kra, code: t.code, output: "", issues: "", auto: true });
        qUse.set(k, (qUse.get(k) || 0) + 1); yearUse.set(k, (yearUse.get(k) || 0) + 1); rep.rows_added++;
      }
      if (!had) rep.months_filled.push(m.month);
    });
  }

  // results and issues for every chosen row that lacks them
  const lastIssue = new Map<string, string>(), lastBelow = new Map<string, boolean>(), occ = new Map<string, number>();
  months.forEach((m, mi) => m.rows.forEach((x) => {
    if (!x.kra) return;
    const k = key(x), t = byKey.get(k) || { code: x.code, kra: x.kra };
    const n = (occ.get(k) || 0); occ.set(k, n + 1);
    let met = true;
    if (!String(x.output || "").trim()) {
      const below = !lastBelow.get(k) && mi > 0 && r() < 0.12;
      const res = result(scaleOf(t), r, below);
      if (res) { x.output = res.value; met = res.met; lastBelow.set(k, !res.met); x.auto = true; rep.results_filled++; }
    } else {
      const s = scaleOf(t), v = Number(String(x.output).replace(/[^\d.]/g, ""));
      if (s && s.target !== null && Number.isFinite(v)) { const tv = s.frac && v <= 1 ? v * 100 : v; met = s.lower ? tv <= Number(s.target) : tv >= Number(s.target); }
    }
    if (!String(x.issues || "").trim()) {
      const causes = CAUSES[catOf(x.kra)] || CAUSES.care;
      let c = fill(causes[(n + hash(k)) % causes.length]);
      if (c === lastIssue.get(k)) c = fill(causes[(n + hash(k) + 1) % causes.length]);
      lastIssue.set(k, c);
      const res = resources[(mi + n) % Math.min(resources.length, mine.length ? Math.max(2, mine.length) : 3)];
      x.issues = (met ? "Target met. " : "") + c + (c.toLowerCase().includes(res.slice(0, 12).toLowerCase()) ? "" : " " + res);
      x.auto = true; rep.issues_written++;
    }
  }));

  tasks.forEach((t) => { if (!months.some((m) => m.rows.some((x) => x.kra && key(x) === key(t)))) rep.tasks_not_used.push(t.kra); });

  // "about your year": only the empty answers
  const x = d.extras = { ...(d.extras || {}) };
  const tally = new Map<string, number>();
  months.forEach((m) => m.rows.forEach((y) => { if (y.kra) tally.set(key(y), (tally.get(key(y)) || 0) + 1); }));
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => byKey.get(k)).filter(Boolean) as Task[];
  const cats = new Map<string, number>(); top.forEach((t) => cats.set(catOf(t.kra), (cats.get(catOf(t.kra)) || 0) + (tally.get(key(t)) || 0)));
  const mainCat = [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c).find((c) => TRAINING[c]);
  const where = unit ? ` in ${unit.replace(/\s*\(+\s*$/, "").replace(/\s+/g, " ")}` : "";
  const w: Record<string, string> = {
    outstanding_performance: top.length >= 2 ? `Met the set targets in ${plain(top[0].kra)} and ${plain(top[1].kra)} through the year.` : `Met the set targets in ${plain(top[0].kra)} through the year.`,
    areas_of_improvement: `${IMPROVE[resources[0]] || "Adequate staffing"}${resources[1] && IMPROVE[resources[1]] && IMPROVE[resources[1]] !== IMPROVE[resources[0]] ? " and " + IMPROVE[resources[1]].charAt(0).toLowerCase() + IMPROVE[resources[1]].slice(1) : ""}.`,
    training_needs: (kids && !["students", "theatre", "palliative"].includes(mainCat || "") ? "Paediatric emergency and palliative care training." : TRAINING[mainCat || ""]) || (/director|chief/i.test(emp.designation || "") ? TRAINING.admin : "Continuing clinical nursing education and skills update."),
    future_goals: `To sustain quality nursing care${where} and meet every monthly target in 2026.`,
    other_feedback: "Continued teamwork and support from management will help sustain these results.",
  };
  EXTRA_KEYS.forEach((k) => { if (!String(x[k] || "").trim()) { x[k] = w[k]; rep.extras_filled.push(k); } });

  d.monthly = months.map((m) => ({ ...m, rows: m.rows.map(({ auto, ...rest }) => rest) }));
  rep.changed = rep.rows_added + rep.results_filled + rep.issues_written + rep.duplicates_removed + rep.extras_filled.length > 0;
  return { data: d, report: rep };
}
