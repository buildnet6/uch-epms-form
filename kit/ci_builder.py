"""Runs inside GitHub Actions (.github/workflows/build-workbooks.yml).

Asks the EPMS backend which paid or complimentary nurses have a finished form without an up-to-date workbook,
builds each one (Excel workbook, one-page summary, printed PDF) and uploads the files to private storage.
The backend only answers this repository's workflow: it checks GitHub's signed OIDC token, so the public
repository holds no keys. Logs stay deliberately quiet: no names, answers or signatures are ever printed.

    python3 kit/ci_builder.py --check     # prints pending=yes|no (cheap, before installing LibreOffice)
    python3 kit/ci_builder.py             # build everything pending
"""
import base64, hashlib, json, os, sys, tempfile, traceback, urllib.request

FUNCTION = "https://myebhfkovfmltoirptrl.supabase.co/functions/v1/epms-builder"
AUDIENCE = "epms-builder"
HERE = os.path.dirname(os.path.abspath(__file__))
BUNDLE = os.path.join(HERE, "sigbundle.enc")


def oidc_token():
    url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"] + "&audience=" + AUDIENCE
    req = urllib.request.Request(url, headers={"Authorization": "bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["value"]


TOKEN = None


def call(op, **kw):
    body = json.dumps({"op": op, **kw}).encode()
    req = urllib.request.Request(FUNCTION, data=body, method="POST",
                                 headers={"Content-Type": "application/json", "x-gh-oidc": TOKEN})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def apply_bundle():
    """One-time import of signatures that were supplied to the admin outside the form (encrypted at rest in git)."""
    if not os.path.exists(BUNDLE):
        return 0
    key = call("secret", name="sigbundle_key").get("value")
    if not key:
        return 0
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    blob = open(BUNDLE, "rb").read()
    items = json.loads(AESGCM(base64.b64decode(key)).decrypt(blob[:12], blob[12:], None))
    changed = 0
    for it in items:
        r = call("set_signature", id=it["id"], field=it["field"], png=it["png"])
        changed += 0 if r.get("unchanged") else 1
    print(f"signature bundle: {len(items)} checked, {changed} stored")
    return changed


def fingerprint(xlsx):
    """A hash of every cell value, so a build can be compared with one made elsewhere without sharing contents."""
    import openpyxl
    wb = openpyxl.load_workbook(xlsx)
    h = hashlib.md5()
    for ws in wb.worksheets:
        h.update(ws.title.encode())
        for row in ws.iter_rows():
            for c in row:
                if c.value is not None:
                    h.update(f"{c.coordinate}={c.value}".encode())
    return h.hexdigest()


def build_one(nid):
    sys.path.insert(0, HERE)
    import build
    got = call("get", id=nid)
    with tempfile.TemporaryDirectory() as out:
        rep = build.build(got["data"], out)
        names = []
        for key in ("xlsx", "printed", "summary"):
            path = rep[key]
            name = os.path.basename(path)
            with open(path, "rb") as fh:
                call("put_file", id=nid, name=name, b64=base64.b64encode(fh.read()).decode())
            names.append(name)
        report = {k: rep[k] for k in ("pages", "page_map_ok", "quarters", "results_met", "results_total", "signed", "flags")}
        report["fingerprint"] = fingerprint(rep["xlsx"])
        call("done", id=nid, files=names, report=report, started_at=got["started_at"])
        return report


def main():
    global TOKEN
    TOKEN = oidc_token()
    if "--check" in sys.argv:
        jobs = call("jobs")["jobs"]
        pending = bool(jobs) or (os.path.exists(BUNDLE) and bool(call("secret", name="sigbundle_key").get("value")))
        print("pending=" + ("yes" if pending else "no"))
        return
    apply_bundle()
    jobs = call("jobs")["jobs"]
    print(f"{len(jobs)} workbook(s) to build")
    failed = 0
    for nid in jobs:
        try:
            rep = build_one(nid)
            print(f"built {nid[:8]}: {rep['results_met']}/{rep['results_total']} at target, quarters {rep['quarters']}, {len(rep['flags'])} flag(s)")
        except Exception as e:
            failed += 1
            where = "; ".join(f"{os.path.basename(f.filename)}:{f.lineno}" for f in traceback.extract_tb(e.__traceback__)[-3:])
            print(f"FAILED {nid[:8]}: {type(e).__name__} at {where}")
            try:
                call("fail", id=nid, error=f"{type(e).__name__} at {where}")
            except Exception:
                pass
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
