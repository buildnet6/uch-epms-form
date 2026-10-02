"""Recalculate every formula in an .xlsx in place with headless LibreOffice, then count Excel errors."""
import os, sys, subprocess, tempfile, time
from pathlib import Path

MACRO = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">
    Sub RecalculateAndSave()
      ThisComponent.calculateAll()
      ThisComponent.store()
      ThisComponent.close(True)
    End Sub
</script:module>"""
ERRORS = ("#VALUE!", "#DIV/0!", "#REF!", "#NAME?", "#NULL!", "#NUM!", "#N/A")


def recalc(path, timeout=180):
    path = str(Path(path).absolute())
    env = dict(os.environ, SAL_USE_VCLPLUGIN="svp")
    with tempfile.TemporaryDirectory(prefix="lo-profile-") as prof:
        url = Path(prof).as_uri()
        subprocess.run(["soffice", "--headless", "--terminate_after_init", f"-env:UserInstallation={url}"],
                       env=env, capture_output=True, timeout=timeout)
        macro_dir = Path(prof) / "user" / "basic" / "Standard"
        macro_dir.mkdir(parents=True, exist_ok=True)
        (macro_dir / "Module1.xba").write_text(MACRO)
        before = os.stat(path).st_mtime_ns
        subprocess.run(["soffice", "--headless", "--norestore", f"-env:UserInstallation={url}",
                        "vnd.sun.star.script:Standard.Module1.RecalculateAndSave?language=Basic&location=application", path],
                       env=env, capture_output=True, timeout=timeout)
        if os.stat(path).st_mtime_ns == before:
            raise RuntimeError("LibreOffice did not rewrite the workbook; formulas were not recalculated")
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)
    bad = [f"{ws.title}!{c.coordinate}" for ws in wb for row in ws.iter_rows() for c in row
           if isinstance(c.value, str) and any(e in c.value for e in ERRORS)]
    return bad


if __name__ == "__main__":
    print(recalc(sys.argv[1]))
