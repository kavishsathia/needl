"""Layout and copy checks for manual.pdf. Run: python3 -I check_pdf.py manual.tex manual.pdf

Checks: page geometry, smallest font size, text inside the margins (no clipping), every command line in a
`cmd` listing extracts from the PDF as one unbroken line, links are clickable, no leftover placeholders.
Exits non-zero on any failure.
"""
import re
import sys

import pymupdf

tex_path, pdf_path = sys.argv[1], sys.argv[2]
tex = open(tex_path, encoding="utf-8").read()
doc = pymupdf.open(pdf_path)
failures: list[str] = []
MM = 72 / 25.4

print(f"pages: {doc.page_count}")
sizes: dict[float, int] = {}
for number, page in enumerate(doc, start=1):
    width, height = page.rect.width, page.rect.height
    if abs(width - 595.3) > 1 or abs(height - 841.9) > 1:
        failures.append(f"page {number}: not A4 ({width:.0f}x{height:.0f})")
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                if not span["text"].strip():
                    continue
                size = round(span["size"], 1)
                sizes[size] = sizes.get(size, 0) + len(span["text"])
                x0, y0, x1, y1 = span["bbox"]
                # Text area is 20 mm from the left and right edges (allow 2 mm for frame padding); the running
                # header and footer sit about 7 mm from the top and bottom edges.
                if x0 < 18 * MM or x1 > width - 18 * MM or y0 < 5 * MM or y1 > height - 5 * MM:
                    failures.append(f"page {number}: text outside margins {span['bbox']} {span['text'][:40]!r}")

print("font sizes (pt: characters):", dict(sorted(sizes.items())))
body = max(sizes, key=sizes.get)
print(f"dominant body size: {body} pt; smallest size used: {min(sizes)} pt")
if body < 10.9:
    failures.append(f"body text is {body} pt, expected 11 pt")

# Every command line must come out of the PDF text as a single line (no wrapping inside the box).
text_lines = set()
for page in doc:
    for raw in page.get_text().splitlines():
        text_lines.add(raw.strip())
commands = re.findall(r"\\begin\{cmd\}\n(.*?)\\end\{cmd\}", tex, flags=re.S)
checked = 0
for block in commands:
    for line in block.splitlines():
        if not line.strip():
            continue
        checked += 1
        if line.strip() not in text_lines:
            failures.append(f"command line wrapped or altered in PDF: {line.strip()!r}")
print(f"command lines checked: {checked}")

links = [link["uri"] for page in doc for link in page.get_links() if link.get("uri")]
print(f"clickable links: {len(links)} ({len(set(links))} distinct)")
for uri in sorted(set(links)):
    print("  ", uri)
if len(set(links)) < 15:
    failures.append("fewer clickable links than expected")

all_text = "\n".join(page.get_text() for page in doc)
for marker in ("TODO", "XXX", "FIXME", "PLACEHOLDER", "lorem"):
    if marker.lower() in all_text.lower():
        failures.append(f"leftover marker {marker!r} in PDF text")

if failures:
    print("FAIL")
    for failure in failures:
        print(" -", failure)
    sys.exit(1)
print("OK")
