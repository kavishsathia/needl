# Result: Needl MCP + webhook setup manual

## Deliverables (this directory)

| File | What it is |
| --- | --- |
| `manual.pdf` | Compiled manual: 25 A4 pages, 11 pt DejaVu Sans body, clickable links |
| `manual.tex` | Editable XeLaTeX source |
| `BUILD.md` | Build and check instructions |
| `check_pdf.py` | Automated layout, copy and link checks |
| `SOURCES.md` | Evidence map: Needl code references at `16eec52`, vendor URLs checked 2026-10-19 |
| `.gitignore` | Ignores LaTeX intermediate files |

## Contents

1. Orientation:
   - MCP vs webhook (two separate connections per tool)
   - order of work
   - per-tool permissions checklist with one handoff each
   - Stripe sandbox only
   - rules for handling secrets
2. One-time preparation:
   - Mac Terminal and Claude Code
   - the four moves of every MCP setup (add with `--scope user`, `claude mcp login`, `claude mcp list`, read-only prompt)
   - how the Needl Connections page and Connect dialog behave
   - every Needl status text, verbatim from code
3. One chapter per tool: GitLab, Linear, LaunchDarkly, Sentry, PostHog, Intercom and Stripe. Each has:
   - (A) the official MCP: endpoint, command, OAuth consent, read-only prompt
   - (B) the webhook, done in the tool's interface plus Needl, with copy-and-paste boxes
   - (C) a safe named test and Needl's success text
   - (D) fixes and handoffs
4. After setup: final checklist, general MCP fixes, safe-use guidance, limitations, official sources.

Key decisions grounded in code:

- **GitLab: verify, don't recreate.** The existing push → webhook → agent path is left untouched. The Duo flow panel is described as a separate connection, and the Maintainer blocker is stated.
- **Save the secret in Needl before any test delivery.** Routes return 404 until a secret is saved (`ingestion.ts`).
- **Steps are ordered by who generates the secret.**
  - Needl generates nothing here: Linear, LaunchDarkly, Sentry, Stripe and Intercom issue their own secrets.
  - GitLab generates the signing token in its webhook form.
  - PostHog needs a user-supplied secret, so the manual generates a `whsec_` secret locally with `openssl`.
- **Intercom risk flagged.** Intercom validates URLs with HEAD, but Needl only routes POST on `/api/hooks/<id>`.
- **Stripe uses Snapshot payloads only.** Every Stripe action happens in a sandbox.

## Checks actually run

- **XeLaTeX** (TinyTeX) build, two passes: exit 0. `manual.log` has no `Overfull`, `Missing character`, `Font Warning` or undefined references.
- **`python3 -I check_pdf.py manual.tex manual.pdf`**: `OK`.
  - 25 pages, all A4.
  - Dominant text size 10.9 pt (11 pt nominal); smallest is the 10 pt header/footer.
  - No text spans outside the margins.
  - All 32 command lines extract from the PDF as unbroken lines.
  - 44 link annotations (30 distinct URLs).
  - No placeholder markers.
- **Visual inspection.** Every page was rendered with PyMuPDF and looked at; issues found were fixed, including:
  - commands wrapping inside boxes
  - missing italic font
  - a step label pushed into the margin
  - the PostHog clipboard order
- **Command syntax.** Every shell command in the manual passes `bash -n`. zsh is not installed on this Linux host; the commands are POSIX-compatible.
- **PostHog body.** The JSON body in the PDF parses and matches `connectionGuides.ts` exactly.
- **Secret format.** The `whsec_` generator was run once locally (value not printed or stored). The output is `whsec_` plus valid base64 decoding to 32 bytes, which meets PostHog's 24-byte minimum and Needl's `whsec_` check.
- **Claude Code CLI.** Flags were checked with `claude mcp add --help`, `claude mcp --help` and `claude mcp login --help` (Claude Code 2.1.302). No MCP server was added or changed on this host.

## Not verified

- No vendor account was signed in to. No webhook, integration, MCP connection, deployment or paid action was performed, and no authenticated UI was exercised.
- Some labels come from third-party guides because vendor docs don't name them; these are marked in `SOURCES.md`:
  - the Sentry integration form
  - the LaunchDarkly `Secret` field
  - Intercom `Send a test request`
- Intercom's HEAD validation against Needl was inferred from code, not tried live.
- It is unknown whether PostHog Cloud already shows the `Signing secret` input, and what plan it needs. The manual includes the Authorization-header fallback.
- The exact output text of `claude mcp add` and `claude mcp login` on the user's Mac version is unknown.
- Needl runtime and business code are unchanged; only `docs/setup-manual/` was added.
