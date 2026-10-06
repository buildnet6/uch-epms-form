"""One-page, easy-to-read summary of a nurse's EPMS workbook.

Usage:  python summary_pdf.py submission.json [more.json ...] --out OUTDIR
Reads the same `data` object as fill_epms.py and writes EPMS_<year>_<Surname>_<First>_Summary.pdf.
The workbook stays the official document; this page only restates what was filled in it.
"""
import os, re, sys, json, argparse
from collections import Counter
import openpyxl
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer, KeepTogether)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fill_epms import TEMPLATE, CONTRACT, Contract, num_val, norm, out_name, add_custom_tasks  # noqa: E402

FONT_DIR = '/usr/share/fonts/truetype/dejavu/'
pdfmetrics.registerFont(TTFont('Sans', FONT_DIR + 'DejaVuSans.ttf'))
pdfmetrics.registerFont(TTFont('Sans-Bold', FONT_DIR + 'DejaVuSans-Bold.ttf'))
pdfmetrics.registerFont(TTFont('Sans-Oblique', FONT_DIR + 'DejaVuSans-Oblique.ttf'))
pdfmetrics.registerFontFamily('Sans', normal='Sans', bold='Sans-Bold', italic='Sans-Oblique')

GREEN = colors.HexColor('#3E6B2B'); GREEN_SOFT = colors.HexColor('#E3ECDC'); AMBER = colors.HexColor('#F2B705')
AMBER_SOFT = colors.HexColor('#FFF4CC'); INK = colors.HexColor('#1B2419'); INK2 = colors.HexColor('#4A5646')
LINE = colors.HexColor('#D5DCCF'); MUTED = colors.HexColor('#6B7667')

BAND_NAMES = ['Outstanding', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor']
BAND_COLORS = {'Outstanding': colors.HexColor('#2E7D32'), 'Excellent': colors.HexColor('#3E6B2B'),
               'Very good': colors.HexColor('#5B7F2A'), 'Good': colors.HexColor('#8A6D00'),
               'Fair': colors.HexColor('#B25E00'), 'Poor': colors.HexColor('#B3261E')}
MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
ISSUE_WORDS = ['Shortage of personnel', 'Shortage of manpower', 'Irregular power supply', 'Poor power supply', 'High patient load', 'Shortage of consumables',
               'Equipment breakdown', 'Network downtime']


def st(name, size=8.2, lead=None, bold=False, color=INK, **kw):
    return ParagraphStyle(name, fontName='Sans-Bold' if bold else 'Sans', fontSize=size,
                          leading=lead or size * 1.28, textColor=color, **kw)


S_TITLE = st('t', 17, 20, True, GREEN)
S_SUB = st('s', 8.3, 11, color=INK2)
S_H = st('h', 9.6, 12, True, GREEN, spaceBefore=5, spaceAfter=2.5)
S_B = st('b', 8.1, 10.2)
S_SMALL = st('sm', 7.2, 9, color=INK2)
S_CELL = st('c', 7.4, 9)
S_CELLB = st('cb', 7.4, 9, True)
S_HEAD = st('hd', 7.2, 9, True, colors.white)
S_BUL = st('bu', 8.0, 10.2, leftIndent=9, bulletIndent=0)


def esc(s):
    return (str(s or '')).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def short_task(t, n=58):
    t = ' '.join(str(t or '').split()).strip(' .')
    m = re.search(r'[,;:(]| through | by | for better ', t)
    if m and m.start() >= 14:
        t = t[:m.start()].strip()
    return t if len(t) <= n else t[:n - 1].rstrip() + '…'


def band_val(b):
    s = str(b).strip()
    m = re.match(r'([<>]?)\s*([\d.]+)', s)
    return (m.group(1), float(m.group(2))) if m else (None, None)


class Task:
    """What the contract says about one task: target, unit, rating bands."""
    def __init__(self, ws, row):
        self.target = ws.cell(row, 13).value
        self.unit = str(ws.cell(row, 19).value or '').strip()
        self.bands = [ws.cell(row, c).value for c in range(21, 27)]
        top = str(self.bands[0]).strip()
        vals = [band_val(b)[1] for b in self.bands]
        self.lower = top.startswith('<') or (None not in vals[:5] and vals[0] < vals[1] < vals[4])
        self.frac = self.unit == '%' and isinstance(self.target, (int, float)) and 0 < self.target <= 1
        # contract rows whose bands contradict their own target: leave them unrated
        self.rateable = not (self.unit == '%' and self.lower and isinstance(self.target, (int, float)) and self.target >= 90)
        if not self.rateable:
            self.lower = False
        if norm(ws.cell(row, 2).value).startswith('clinic workflow optimization'):
            self.unit = '#'                  # a number on a 10/8/6/4/3 scale, not a true percentage
        if isinstance(self.target, (int, float)) and self.unit == '#' and top.startswith('>') and self.target > 10 * (vals[1] or 1):
            self.target = vals[1]            # e.g. "Cascade of PMS": target cell 930, scale 0-4

    def compare_value(self, n):
        return n * 100 if self.frac and n <= 1 else n

    def target_text(self):
        t = self.target
        if not isinstance(t, (int, float)):
            return str(t or '')
        t = int(t) if float(t).is_integer() else t
        if self.frac:
            return f"{t:g} (= {t*100:g}%)"
        if self.unit == '%':
            return f"{t:g}%" + (" or less" if self.lower else "")
        if self.unit.lower().startswith('min'):
            return f"{t:g} min or less"
        return f"{t:g}" + (" or fewer" if self.lower else "")

    def rating(self, n):
        if not self.rateable or not isinstance(n, (int, float)):
            return None
        v = self.compare_value(n)
        for i, b in enumerate(self.bands):
            op, x = band_val(b)
            if x is None:
                continue
            if self.lower:
                if op == '<' and i == 0 and v < x: return BAND_NAMES[0]
                if op in (None, '') and v <= x: return BAND_NAMES[i]
                if op == '>' and v > x: return BAND_NAMES[5]
            else:
                if op == '>' and v > x: return BAND_NAMES[i]
                if op in (None, '') and v >= x: return BAND_NAMES[i]
        return BAND_NAMES[5]

    def meets(self, n):
        if not isinstance(n, (int, float)) or not isinstance(self.target, (int, float)):
            return None
        v = self.compare_value(n); t = self.compare_value(self.target) if self.frac else self.target
        return v <= t if self.lower else v >= t

    def show(self, n):
        if not isinstance(n, (int, float)):
            return esc(n)
        n2 = int(n) if float(n).is_integer() else n
        if self.frac:
            return f"{n2:g} <font color='#6B7667'>(={n*100:g}%)</font>" if n <= 1 else f"{n2:g}%"
        if self.unit == '%':
            return f"{n2:g}%"
        if self.unit.lower().startswith('min'):
            return f"{n2:g} min"
        return f"{n2:g}"


def person(p):
    name = ' '.join(x.strip() for x in [p.get('surname'), p.get('first_name'), p.get('other_name')] if x and x.strip())
    bits = [b for b in [p.get('designation'), ('IPPIS ' + p['ippis']) if p.get('ippis') else ''] if b]
    return f"<b>{esc(name) or '—'}</b><br/><font color='#4A5646'>{esc(' · '.join(bits))}</font>"


def summary(data, out_path, compact=0):
    wb = openpyxl.load_workbook(TEMPLATE, data_only=True)
    ws = wb[CONTRACT]
    add_custom_tasks(ws, data)
    contract = Contract(ws)
    emp, sup, cso = data.get('employee', {}), data.get('supervisor', {}), data.get('countersigning_officer', {})
    extras = data.get('extras', {}) or {}
    year = data.get('year', 2025)
    monthly = (data.get('monthly') or [])[:12]
    while len(monthly) < 12:
        monthly.append({'rows': []})

    tasks, order = {}, []          # key -> (Task|None, code, text, months used)
    entries = []                   # (month index, key, value, rating, meets)
    issues = Counter()
    issue_months = {}
    for mi, m in enumerate(monthly):
        for r in (m.get('rows') or [])[:10]:
            text = (r.get('kra') or '').strip()
            if not text:
                continue
            key = (r.get('code', ''), norm(text))
            if key not in tasks:
                cr = contract.find(r.get('code', ''), text)
                tasks[key] = [Task(ws, cr) if cr else None, r.get('code') or 'OWN', text, []]
                order.append(key)
            tasks[key][3].append(MONTHS[mi])
            n = num_val(r.get('output'))
            t = tasks[key][0]
            entries.append((mi, key, n, t.rating(n) if t else None, t.meets(n) if t else None))
            for w in ISSUE_WORDS:
                if w.lower() in (r.get('issues') or '').lower():
                    issue_months.setdefault(w, set()).add(mi)
    for w, ms in issue_months.items():
        issues[w] = len(ms)                      # count months, not entries

    doc = SimpleDocTemplate(out_path, pagesize=A4, leftMargin=13 * mm, rightMargin=13 * mm,
                            topMargin=11 * mm, bottomMargin=10 * mm,
                            title=f"EPMS {year} summary - {emp.get('surname', '')} {emp.get('first_name', '')}",
                            author='BuildNET Digital Solutions')
    W = A4[0] - 26 * mm
    story = []

    # ---- title
    name = ' '.join(x for x in [emp.get('first_name'), emp.get('other_name'), emp.get('surname')] if x)
    unit = ' · '.join(x for x in [emp.get('department') or 'Clinical Nursing', emp.get('unit')] if x)
    head = Table([[Paragraph(f"EPMS {year} at a glance", S_TITLE),
                   Paragraph(f"<b>{esc(name)}</b><br/>{esc(emp.get('designation', ''))} · IPPIS {esc(emp.get('ippis', ''))}<br/>{esc(unit)}",
                             st('hr', 8.4, 11, color=INK, alignment=2))]],
                 colWidths=[W * 0.52, W * 0.48])
    head.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 0),
                              ('RIGHTPADDING', (0, 0), (-1, -1), 0), ('LINEBELOW', (0, 0), (-1, 0), 2, AMBER),
                              ('BOTTOMPADDING', (0, 0), (-1, -1), 5)]))
    story += [head, Spacer(1, 3),
              Paragraph("Everything filled in your EPMS workbook on one page. The Excel workbook remains the official document you submit.", S_SUB), Spacer(1, 3)]

    # ---- people + headline numbers
    filled = [e for e in entries if isinstance(e[2], (int, float))]
    months_filled = len({e[0] for e in filled})
    met = sum(1 for e in filled if e[4])
    blanks = [f"{MONTHS[mi]} task {ri + 1}" for mi, m in enumerate(monthly)
              for ri, r in enumerate((m.get('rows') or [])[:10]) if (r.get('kra') or '').strip() and num_val(r.get('output')) is None]
    ppl = Table([[Paragraph("<font color='#6B7667' size='6.8'>APPRAISEE</font>", S_CELL),
                  Paragraph("<font color='#6B7667' size='6.8'>SUPERVISOR (APPRAISER)</font>", S_CELL),
                  Paragraph("<font color='#6B7667' size='6.8'>COUNTER-SIGNING OFFICER</font>", S_CELL)],
                 [Paragraph(person(emp), S_CELL), Paragraph(person(sup), S_CELL), Paragraph(person(cso), S_CELL)]],
                colWidths=[W / 3] * 3)
    ppl.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), GREEN_SOFT), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                             ('TOPPADDING', (0, 0), (-1, -1), 2.5), ('BOTTOMPADDING', (0, 1), (-1, 1), 5),
                             ('LINEAFTER', (0, 0), (1, -1), 0.6, colors.white)]))
    stats = [(f"{months_filled}/12", "months filled"), (str(len(order)), "tasks used"),
             (f"{met}/{len(filled)}", "results at or above target"), (str(len(blanks)), "results still blank")]
    stat_t = Table([[Paragraph(f"<font size='13' color='#3E6B2B'><b>{a}</b></font><br/><font size='6.9' color='#4A5646'>{b}</font>",
                               st('x', 7, 9, alignment=1)) for a, b in stats]], colWidths=[W / 4] * 4)
    stat_t.setStyle(TableStyle([('BOX', (0, 0), (-1, -1), 0.6, LINE), ('LINEAFTER', (0, 0), (2, 0), 0.6, LINE),
                                ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4)]))
    story += [ppl, Spacer(1, 4), stat_t]

    # grid layout (one column per task) when nurses report more than two tasks a month and have few tasks overall
    per_month = Counter(e[0] for e in entries)
    dense = bool(per_month) and len(order) <= 10 and sum(per_month.values()) >= 0.8 * 12 * len(order)   # nearly every task every month
    grid = bool(per_month) and max(per_month.values()) > 2 and (len(order) <= 6 or dense)
    listing = bool(per_month) and max(per_month.values()) > 2 and not grid     # many tasks: one line per month
    label = {key: f"T{i + 1}" for i, key in enumerate(order)}

    # ---- tasks
    story.append(Paragraph("Your tasks (Key Result Areas) and contract targets", S_H))
    rows = [[Paragraph(h, S_HEAD) for h in ("Code", "Task", "Target", "Months used")]]
    for key in order:
        t, code, text, used = tasks[key]
        rows.append([Paragraph((f"<b>{label[key]}</b> · " if (grid or listing) else "") + esc(code), S_CELLB), Paragraph(esc(short_task(text, 72 if listing else 95)), S_CELL),
                     Paragraph(esc(t.target_text()) if t else '—', S_CELL), Paragraph('All 12 months' if len(set(used)) == 12 else (f"{len(set(used))} months" if listing else ', '.join(dict.fromkeys(used))), S_CELL)])
    tstyle = TableStyle([('BACKGROUND', (0, 0), (-1, 0), GREEN), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                         ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F5F7F2')]),
                         ('LINEBELOW', (0, 1), (-1, -1), 0.3, LINE), ('TOPPADDING', (0, 0), (-1, -1), 1.6),
                         ('BOTTOMPADDING', (0, 0), (-1, -1), 1.6)])
    if len(order) > 8 and compact >= 1:
        # a long task list sits in two side-by-side columns so the page keeps to one sheet
        SC = st('tc2', 6.4, 7.6)
        half = (len(order) + 1) // 2
        def col(keys):
            rr = [[Paragraph(h, S_HEAD) for h in ("Code", "Task", "Target")]]
            for key in keys:
                t, code, text, used = tasks[key]
                tgt = (t.target_text() if t else '—').split(' (')[0]
                rr.append([Paragraph(f"<b>{label[key]}</b> " + esc(code), SC), Paragraph(esc(short_task(text, 40)), SC), Paragraph(esc(tgt), SC)])
            tb = Table(rr, colWidths=[W * 0.13, W * 0.27, W * 0.09]); tb.setStyle(tstyle)
            tb.setStyle(TableStyle([('TOPPADDING', (0, 0), (-1, -1), 0.8), ('BOTTOMPADDING', (0, 0), (-1, -1), 0.8)])); return tb
        tt = Table([[col(order[:half]), col(order[half:])]], colWidths=[W * 0.5, W * 0.5])
        tt.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 3)]))
    else:
        tt = Table(rows, colWidths=([W * 0.16, W * 0.62, W * 0.11, W * 0.11] if listing else [W * 0.13, W * 0.55, W * 0.13, W * 0.19]), repeatRows=1)
        tt.setStyle(tstyle)
    story.append(tt)

    # ---- month by month
    story.append(Paragraph("Month by month: what your workbook shows", S_H))
    mrows = [[Paragraph(h, S_HEAD) for h in ("", "Task 1", "Output", "Rating", "Task 2", "Output", "Rating")]]
    by_month = {mi: [] for mi in range(12)}
    for e in entries:
        by_month[e[0]].append(e)
    if grid:
        wide = len(order) > 6
        RS = st('gr', 6.5 if wide else 7.2, 8 if wide else 8.6, alignment=1)
        ABBR = {'Outstanding': 'O', 'Excellent': 'E', 'Very good': 'VG', 'Good': 'G', 'Fair': 'F', 'Poor': 'P'}
        mrows = [[Paragraph("", S_HEAD)] + [Paragraph(label[k], st('gh', 7.2, 9, True, colors.white, alignment=1)) for k in order]]
        for mi in range(12):
            cells = [Paragraph(f"<b>{MONTHS[mi]}</b>", S_CELL)]
            got = {e[1]: e for e in by_month[mi]}
            for key in order:
                e = got.get(key)
                if not e:
                    cells.append(Paragraph("<font color='#6B7667'>—</font>", RS)); continue
                _, _, n, rating, _ = e
                t = tasks[key][0]
                val = (t.show(n) if t else esc(n)) if n is not None else "<font color='#B3261E'><b>blank</b></font>"
                if wide and t is not None and t.frac and isinstance(n, (int, float)) and n <= 1:
                    val = f"{n * 100:g}%"                     # a fraction shown as a plain percentage in a narrow column
                rt = f" <font color='{BAND_COLORS[rating].hexval().replace('0x', '#')}'><b>{ABBR[rating]}</b></font>" if rating else ""
                cells.append(Paragraph(val + rt, RS))
            mrows.append(cells)
        cw = [W * 0.08] + [W * 0.92 / len(order)] * len(order)
        mt = Table(mrows, colWidths=cw, repeatRows=1)
        mt.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), GREEN), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F5F7F2')]),
                                ('LINEBELOW', (0, 1), (-1, -1), 0.3, LINE), ('TOPPADDING', (0, 0), (-1, -1), 1.5), ('BOTTOMPADDING', (0, 0), (-1, -1), 1.5)]))
        story += [mt, Spacer(1, 1.5),
                  Paragraph("Each cell shows the Output Status and its rating on the contract's own scale: O Outstanding (100% of the task's marks), "
                            "E Excellent (90%), VG Very good (80%), G Good (70%), F Fair (60%), P Poor (50%). A guide only: your supervisor gives the final rating.", S_SMALL)]
    if listing:
        ABBR2 = {'Outstanding': 'O', 'Excellent': 'E', 'Very good': 'VG', 'Good': 'G', 'Fair': 'F', 'Poor': 'P'}
        LS = st('ls', 7.3, 9.4)
        mrows = [[Paragraph("", S_HEAD), Paragraph("Tasks reported that month: Output Status and rating", S_HEAD)]]
        for mi in range(12):
            bits = []
            for _, key, n, rating, _ in by_month[mi]:
                t = tasks[key][0]
                val = (t.show(n) if t else esc(n)) if n is not None else "<font color='#B3261E'><b>blank</b></font>"
                rt = f" <font color='{BAND_COLORS[rating].hexval().replace('0x', '#')}'><b>{ABBR2[rating]}</b></font>" if rating else ""
                bits.append(f"<b>{label[key]}</b> {val}{rt}")
            mrows.append([Paragraph(f"<b>{MONTHS[mi]}</b>", S_CELL), Paragraph("&nbsp;&nbsp;·&nbsp;&nbsp;".join(bits) or "<font color='#6B7667'>no figures</font>", LS)])
        mt = Table(mrows, colWidths=[W * 0.08, W * 0.92], repeatRows=1)
        mt.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), GREEN), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F5F7F2')]),
                                ('LINEBELOW', (0, 1), (-1, -1), 0.3, LINE), ('TOPPADDING', (0, 0), (-1, -1), 1.5), ('BOTTOMPADDING', (0, 0), (-1, -1), 1.5)]))
        story += [mt, Spacer(1, 1.5),
                  Paragraph("T1, T2… are the tasks listed above. Ratings on the contract's own scale: O Outstanding (100% of the task's marks), "
                            "E Excellent (90%), VG Very good (80%), G Good (70%), F Fair (60%), P Poor (50%). A guide only: your supervisor gives the final rating.", S_SMALL)]
    MS = S_CELL if compact < 2 else st('mc', (7.4, 7.4, 6.9, 6.5)[compact], (9, 9, 8.2, 7.6)[compact])
    if not grid and not listing:
        for mi in range(12):
          es_all = by_month[mi]
          for part in range(0, max(1, len(es_all)), 2):          # a third task goes on its own line under the month
            cells = [Paragraph(f"<b>{MONTHS[mi]}</b>" if part == 0 else "", MS)]
            es = es_all[part:part + 2]
            for j in range(2):
                if j < len(es):
                    _, key, n, rating, meets = es[j]
                    t = tasks[key][0]
                    val = (t.show(n) if t else esc(n)) if n is not None else "<font color='#B3261E'><b>blank</b></font>"
                    rt = f"<font color='{BAND_COLORS[rating].hexval().replace('0x', '#')}'><b>{rating}</b></font>" if rating else "<font color='#6B7667'>—</font>"
                    cells += [Paragraph(esc(short_task(tasks[key][2], (52, 36, 30, 28)[compact])), MS), Paragraph(val, MS), Paragraph(rt, MS)]
                else:
                    cells += [Paragraph("<font color='#6B7667'>—</font>" if part == 0 else "", MS), Paragraph('', MS), Paragraph('', MS)]
            mrows.append(cells)
        cw = [W * 0.06] + [W * 0.245, W * 0.1, W * 0.125] * 2
        mt = Table(mrows, colWidths=cw, repeatRows=1)
        mt.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), GREEN), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F5F7F2')]),
                                ('LINEBELOW', (0, 1), (-1, -1), 0.3, LINE), ('LINEBEFORE', (4, 0), (4, -1), 0.8, LINE),
                                ('TOPPADDING', (0, 0), (-1, -1), 1.4 if compact < 2 else 0.6), ('BOTTOMPADDING', (0, 0), (-1, -1), 1.4 if compact < 2 else 0.6)]))
        story += [mt, Spacer(1, 1.5),
                  Paragraph("Rating = where the figure falls on the contract's own scale (Outstanding earns 100% of the task's marks, "
                            "Excellent 90%, Very good 80%, Good 70%, Fair 60%, Poor 50%). It is a guide only: your supervisor gives the final rating.",
                            S_SMALL)]

    # ---- quarters + year, side by side
    q_items = []
    for qi in range(4):
        seen, names = set(), []
        for mi in range(qi * 3, qi * 3 + 3):
            for e in by_month[mi]:
                if e[1] not in seen:
                    seen.add(e[1]); names.append(tasks[e[1]][1])
        q_items.append(Paragraph(f"<b>Q{qi + 1}</b> ({MONTHS[qi*3]}–{MONTHS[qi*3+2]}): "
                                 f"{len(names)} task{'s' if len(names) != 1 else ''} carried into the appraisal"
                                 + (f" <font color='#4A5646'>({esc(', '.join(dict.fromkeys(names)))})</font>" if names else ""),
                                 S_BUL, bulletText='•'))
    left = [Paragraph("Quarterly appraisals", S_H)] + q_items
    if issues:
        top = ', '.join(f"{k.lower()} ({v} month{'s' if v > 1 else ''})" for k, v in issues.most_common(3))
        left += [Paragraph("Challenges you reported most", S_H), Paragraph(esc(top[0].upper() + top[1:]) + '.', S_BUL, bulletText='•')]
    yr = [('Outstanding performance', 'outstanding_performance'), ('Areas of improvement', 'areas_of_improvement'),
          ('Training needs', 'training_needs'), ('Future goals', 'future_goals'), ('Other feedback', 'other_feedback')]
    right = [Paragraph("Your year in your own words", S_H)]
    for label, k in yr:
        v = (extras.get(k) or '').strip()
        right.append(Paragraph(f"<b>{label}:</b> " + (esc(v) if v else "<font color='#6B7667'>left blank</font>"),
                               S_BUL if compact < 2 else st('yb', (8, 8, 7.3, 6.8)[compact], (10, 10, 9, 8.4)[compact], leftIndent=9, bulletIndent=0), bulletText='•'))
    two_holder = (left, right)

    # ---- before you submit
    todo = ["Read through the workbook: every figure above is exactly what it contains."]
    if blanks:
        todo.append("Fill the blank result(s): " + ', '.join(blanks) + ".")
    todo += ["Comments, quarterly scores and dates are pre-filled from your figures; your appraisers may amend them.",
             "Your signature is placed." if data.get('_signed') else "Sign as appraisee on the contract, monthly reviews and quarterly appraisals.",
             "Your supervisor's signature is placed." if data.get('_sup_signed') else "Your supervisor signs the supervisor/appraiser boxes.",
             "Your counter-signer's signature is placed." if data.get('_cso_signed') else "Your counter-signing officer signs the contract and quarterly appraisals."]
    box = [Paragraph("Before you submit", st('bh', 9.2, 11, True, colors.HexColor('#3A2C00')))] + \
          [Paragraph(esc(t), st('bt', 7.9, 10, color=colors.HexColor('#3A2C00'), leftIndent=9), bulletText='✓') for t in todo]
    bt = Table([[box]], colWidths=[W * 0.5 - 4])
    bt.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), AMBER_SOFT), ('BOX', (0, 0), (-1, -1), 0.6, AMBER),
                            ('LEFTPADDING', (0, 0), (-1, -1), 7), ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 5)]))
    right += [Spacer(1, 6), bt]
    two = Table([[left, right]], colWidths=[W * 0.5, W * 0.5])
    two.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 0),
                             ('RIGHTPADDING', (0, 0), (0, 0), 8), ('RIGHTPADDING', (1, 0), (1, 0), 0)]))
    story.append(two)

    def footer(c, d):
        c.saveState(); c.setFont('Sans', 6.8); c.setFillColor(MUTED)
        c.drawString(13 * mm, 6 * mm, "Prepared by BuildNET Digital Solutions · Questions? WhatsApp 08086579390 (messages only, no calls)")
        c.drawRightString(A4[0] - 13 * mm, 6 * mm, f"EPMS {year} summary · {emp.get('surname', '')} {emp.get('first_name', '')}")
        c.restoreState()
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    # keep it to one page: shorten task names in the month table until it fits
    try:
        from pypdf import PdfReader
        if len(PdfReader(out_path).pages) > 1 and compact < 3:
            return summary(data, out_path, compact + 1)
    except ImportError:
        pass
    return doc.page if hasattr(doc, 'page') else None


def summary_name(data):
    return out_name(data).replace('.xlsx', '_Summary.pdf')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+')
    ap.add_argument('--out', default='out')
    ap.add_argument('--signed', action='store_true', help="the workbook carries a signature supplied outside the form")
    ap.add_argument('--sup-signed', action='store_true', help="the supervisor's signature was supplied outside the form")
    ap.add_argument('--cso-signed', action='store_true', help="the counter-signing officer's signature was supplied outside the form")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    for f in a.files:
        d = json.load(open(f))
        d = d.get('data', d)
        d['_signed'] = a.signed or bool((d.get('signature') or {}).get('approved'))
        d['_sup_signed'] = a.sup_signed or bool((d.get('supervisor_signature') or {}).get('approved'))
        d['_cso_signed'] = a.cso_signed or bool((d.get('cso_signature') or {}).get('approved'))
        p = os.path.join(a.out, summary_name(d))
        summary(d, p)
        print('wrote', p)
