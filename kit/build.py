"""One nurse, every deliverable: the Excel workbook (recalculated), the one-page summary PDF and the printed-view PDF.

    python3 build.py nurse.json --out DIR [--signature PNG] [--supervisor-signature PNG] [--cso-signature PNG]

Signatures come from the nurse's saved form (approved uploads) unless a PNG is given for that role.
Prints a JSON report: files, quarter scores, results at or above target, and anything worth a human look.
"""
import argparse, json, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def build(data, outdir, signature=None, supervisor_signature=None, cso_signature=None, images=False):
    import fill_epms, summary_pdf, render_workbook, recalc, openpyxl
    os.makedirs(outdir, exist_ok=True)
    data = data.get('data', data)
    xlsx = os.path.join(outdir, fill_epms.out_name(data))
    given = {'signature': signature, 'supervisor_signature': supervisor_signature, 'cso_signature': cso_signature}
    with tempfile.TemporaryDirectory() as tmp:
        sigs = {f: p or fill_epms.signature_from_data(data, os.path.join(tmp, f + '.png'), f) for f, p in given.items()}
        notes = fill_epms.fill(data, xlsx, sigs['signature'], sigs['supervisor_signature'], sigs['cso_signature'])
    errors = recalc.recalc(xlsx)

    d = dict(data, _signed=bool(sigs['signature']), _sup_signed=bool(sigs['supervisor_signature']),
             _cso_signed=bool(sigs['cso_signature']))
    summary = os.path.join(outdir, summary_pdf.summary_name(data))
    summary_pdf.summary(d, summary)

    r = render_workbook.render(xlsx, outdir, images=images)
    printed = xlsx.replace('.xlsx', '_Printed.pdf')
    os.replace(r['pdf'], printed)

    wb = openpyxl.load_workbook(xlsx, data_only=True)
    quarters = []
    for name in wb.sheetnames:
        if 'APPRAISAL' in name:
            ws = wb[name]
            row = next((i for i in range(40, ws.max_row + 1) if str(ws.cell(i, 6).value or '').startswith('OVERALL RATING')), 50)
            v = ws.cell(row, 15).value
            quarters.append(round(v, 1) if isinstance(v, (int, float)) else None)

    # results against target, the same way the summary judges them
    pms = openpyxl.load_workbook(fill_epms.TEMPLATE, data_only=True)[fill_epms.CONTRACT]
    fill_epms.add_custom_tasks(pms, data)
    contract = summary_pdf.Contract(pms)
    met = total = 0
    below = []
    for m in (data.get('monthly') or [])[:12]:
        for row in (m.get('rows') or [])[:10]:
            v = fill_epms.num_val(row.get('output'))
            cr = contract.find(row.get('code', ''), row.get('kra', '')) if row.get('kra') else None
            if v is None or not cr:
                continue
            ok = summary_pdf.Task(pms, cr).meets(v)
            if ok is None:
                continue
            total += 1; met += bool(ok)
            if not ok:
                below.append(f"{m.get('month', '')[:3]}: {row.get('kra', '')[:40]} = {row.get('output')}")
    flags = list(notes)
    if errors:
        flags.append(f"{len(errors)} formula error(s) after recalculation")
    if below:
        flags.append(f"{len(below)} result(s) below target: " + "; ".join(below[:4]) + (" ..." if len(below) > 4 else ""))
    for role, label in (('signature', 'nurse'), ('supervisor_signature', 'supervisor'), ('cso_signature', 'counter-signer')):
        if not sigs[role]:
            flags.append(f"no {label} signature")
    return {'xlsx': xlsx, 'summary': summary, 'printed': printed, 'pages': r['page_count'], 'page_map_ok': r['map_ok'],
            'quarters': quarters, 'results_met': met, 'results_total': total,
            'signed': {k: bool(v) for k, v in sigs.items()}, 'flags': flags}


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('file')
    ap.add_argument('--out', default='out')
    ap.add_argument('--signature'); ap.add_argument('--supervisor-signature'); ap.add_argument('--cso-signature')
    a = ap.parse_args()
    rep = build(json.load(open(a.file)), a.out, a.signature, a.supervisor_signature, a.cso_signature)
    print(json.dumps(rep, indent=1))
