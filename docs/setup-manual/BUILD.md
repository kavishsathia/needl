# Building the setup manual

`manual.tex` is the editable source and `manual.pdf` is the compiled output. Both are committed.

## Requirements

- XeLaTeX (TeX Live or TinyTeX) with these packages: `fontspec`, `geometry`, `xcolor`, `framed`, `enumitem`, `tabularx`, `booktabs`, `longtable`, `listings`, `fancyhdr`, `titlesec`, `url`, `hyperref`.
- DejaVu Sans and DejaVu Sans Mono fonts installed system-wide. Italics are slanted from the upright face, so DejaVu Sans Oblique doesn't need to be installed.
- For the checks: Python 3 with PyMuPDF (`pip install pymupdf`).

## Build

From this directory, run XeLaTeX twice. The second pass fills in the table of contents and the running headers.

```sh
xelatex -interaction=nonstopmode -halt-on-error manual.tex
xelatex -interaction=nonstopmode -halt-on-error manual.tex
```

Then remove the intermediate files (`manual.aux`, `manual.log`, `manual.out`, `manual.toc`). They are listed in this directory's `.gitignore`.

A clean build has no `Overfull`, `Missing character` or `Font Warning` lines in `manual.log`:

```sh
grep -E "^!|Overfull|Missing character|Font Warning" manual.log
```

## Check

```sh
python3 -I check_pdf.py manual.tex manual.pdf
```

The script checks the following:

- Every page is A4.
- Body text is 11 pt.
- No text falls outside the margins.
- Every line inside a `cmd` box comes out of the PDF text as one unbroken line, so commands copy cleanly.
- Links are clickable.
- No placeholder markers are left.

It prints `OK` or lists each failure.

## Editing rules

- Keep each command line short enough to fit in its box: about 70 characters inside a step. Split longer commands with a trailing `\`, as the `claude mcp add` commands do. `check_pdf.py` fails if a command wraps.
- On-screen labels go in `\ui{...}` and must match the Needl source (`apps/web/src/App.tsx`, `apps/web/src/connectionGuides.ts`) or the vendor documentation listed in `SOURCES.md`.
- The PostHog body shown in Chapter 7 must stay identical to the `template.text` in `apps/web/src/connectionGuides.ts`.
