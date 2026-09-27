"""Make every text box in the workbook show its full contents: wrap text that
would otherwise be cut off and grow row heights to fit the wrapped lines."""
import sys, math, copy
import openpyxl
from openpyxl.utils import get_column_letter
from PIL import ImageFont

FD = '/usr/share/fonts/truetype/'
FONTS = {  # metric-compatible stand-ins, width multiplier
    'calibri': ('crosextra/Carlito', 1.0), 'candara': ('crosextra/Carlito', 1.06),
    'cambria': ('crosextra/Caladea', 1.0), 'bahnschrift': ('crosextra/Carlito', 1.0),
    'century gothic': ('dejavu/DejaVuSans', 1.0),
}
_cache = {}
def font_for(f):
    name = (f.name or 'Calibri').lower()
    base, mult = FONTS.get(name, ('liberation/LiberationSans', 1.0))
    bold = bool(f.b)
    size = float(f.sz or 11)
    key = (base, bold, size)
    if key not in _cache:
        if base.startswith('dejavu'):
            path = FD + base + ('-Bold' if bold else '') + '.ttf'
        elif base.startswith('liberation'):
            path = FD + base + ('-Bold' if bold else '-Regular') + '.ttf'
        else:
            path = FD + base + ('-Bold' if bold else '-Regular') + '.ttf'
        _cache[key] = ImageFont.truetype(path, max(1, round(size * 96 / 72)))
    return _cache[key], mult, size

def text_px(font, mult, s):
    return font.getlength(s) * mult * 1.22  # generous margin for viewers with wider fonts

def break_text(text, font, mult, avail):
    """Greedy word wrap -> list of lines that each fit inside the box."""
    out = []
    for para in str(text).split('\n'):
        words = [w for w in para.replace('\t', ' ').split(' ') if w]
        if not words:
            if out: out.append('')
            continue
        line = ''
        for w in words:
            cand = (line + ' ' + w) if line else w
            if text_px(font, mult, cand) <= avail:
                line = cand
                continue
            if line:
                out.append(line)
            while text_px(font, mult, w) > avail and len(w) > 1:   # very long single word
                k = len(w)
                while k > 1 and text_px(font, mult, w[:k] + '-') > avail:
                    k -= 1
                out.append(w[:k] + '-'); w = w[k:]
            line = w
        out.append(line)
    while out and out[-1] == '':
        out.pop()
    return out or ['']

def col_widths(ws):
    default = ws.sheet_format.defaultColWidth or 8.43
    widths = {}
    for key, dim in ws.column_dimensions.items():
        lo, hi = dim.min or openpyxl.utils.column_index_from_string(key), dim.max or openpyxl.utils.column_index_from_string(key)
        for c in range(lo, hi + 1):
            widths[c] = 0 if dim.hidden else (dim.width if dim.width else default)
    return lambda c: widths.get(c, default)

def px(w):
    return int(w * 7 + 5) if w else 0

def autofit(path_in, path_out, reset_rows=None):
    reset_rows = reset_rows or {}
    wb = openpyxl.load_workbook(path_in)
    for ws in wb.worksheets:
        width = col_widths(ws)
        default_h = ws.sheet_format.defaultRowHeight or 15
        merged_at = {}
        covered = set()
        for rng in ws.merged_cells.ranges:
            merged_at[(rng.min_row, rng.min_col)] = rng
            for r in range(rng.min_row, rng.max_row + 1):
                for c in range(rng.min_col, rng.max_col + 1):
                    covered.add((r, c))
        need = {}          # row -> needed height (single-row cells)
        multi = []         # (rows, needed) for vertically merged cells
        for row in ws.iter_rows():
            for cell in row:
                v = cell.value
                if not isinstance(v, str) or not v.strip() or v.startswith('='):
                    continue
                r, c = cell.row, cell.column
                rng = merged_at.get((r, c))
                if rng:
                    cols = range(rng.min_col, rng.max_col + 1); rows = range(rng.min_row, rng.max_row + 1)
                else:
                    cols = [c]; rows = [r]
                avail = sum(px(width(cc)) for cc in cols) - 8
                if avail <= 10:
                    continue
                font, mult, size = font_for(cell.font)
                al = cell.alignment
                text = v.rstrip()
                one_line = max(text_px(font, mult, p) for p in text.split('\n'))
                wrap = bool(al.wrap_text)
                if not wrap and (one_line > avail or '\n' in text):
                    # let a single-line label spill into empty neighbours, as Excel does
                    spill_ok = False
                    if '\n' not in text and not rng and (al.horizontal in (None, 'general', 'left')):
                        room, cc = avail, c + 1
                        while room < one_line and cc <= ws.max_column + 5:
                            if (r, cc) in covered or ws.cell(r, cc).value not in (None, ''):
                                break
                            room += px(width(cc)); cc += 1
                        spill_ok = room >= one_line
                    if not spill_ok:
                        new = copy.copy(al); new.wrap_text = True
                        if new.vertical is None: new.vertical = 'center'
                        cell.alignment = new
                        wrap = True
                if not wrap:
                    continue
                if " " not in text.strip() and "\n" not in text:
                    broken = [text]          # a single code or number: never split it
                else:
                    broken = break_text(text, font, mult, avail)
                lines = len(broken)
                # hard line breaks so the full text shows in every viewer,
                # even ones that ignore Excel's wrap-text setting
                cell.value = '\n'.join(broken)
                h = lines * size * 1.45 + (size * 1.2 if lines > 1 else 6)
                if len(rows) == 1:
                    need[r] = max(need.get(r, 0), h)
                else:
                    multi.append((list(rows), h))
        for r, h in need.items():
            cur = ws.row_dimensions[r].height
            if r in reset_rows.get(ws.title, ()):
                ws.row_dimensions[r].height = round(max(h, default_h), 1)
            elif cur is None or cur < h:
                ws.row_dimensions[r].height = round(max(h, default_h), 1)
        for rows, h in multi:
            total = sum((ws.row_dimensions[r].height or default_h) for r in rows)
            if total < h:
                last = rows[-1]
                ws.row_dimensions[last].height = round((ws.row_dimensions[last].height or default_h) + (h - total), 1)
    wb.save(path_out)

if __name__ == '__main__':
    autofit(sys.argv[1], sys.argv[2])
