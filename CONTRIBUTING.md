# Contributing to Needl

Thanks for wanting to help. Bug reports, new rules for the use-case catalogue, new integrations and fixes are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Be kind. This project follows the [code of conduct](CODE_OF_CONDUCT.md).
- Never paste real webhook payloads, tokens or customer data into issues, tests or fixtures.

## Setup

You need Node.js 22.13 or later and a local Postgres.

```bash
npm ci
npm --prefix apps/web ci --legacy-peer-deps
createdb needl
echo 'DATABASE_URL=postgres://localhost:5432/needl' > .env
npm run web:dev
```

The app tests create and drop their own throwaway databases. They connect to `postgres://localhost:5432/postgres` unless you set `NEEDL_TEST_DATABASE_URL`.

## Checks

Run these before opening a pull request. CI runs the same ones.

```bash
npm run check        # package: typecheck, tests, build, smoke test
npm run web:test     # app unit and backend tests
npm run web:build    # app typecheck and production build
npm run web:e2e      # optional locally: Playwright browser tests
```

## Where things live

- `src/adapters`: one adapter per provider. Signatures are verified on the raw bytes before parsing.
- `src/rules`: the rule language, its checker and the event catalogue rules can use.
- `src/ltl`: the monitor. Its guarantees are written down in [docs/ltl-semantics.md](docs/ltl-semantics.md); keep that doc and the code in step.
- `apps/web`: the app (React frontend in `src`, API in `backend`).
- `apps/simulator`: sends signed fake webhooks for local testing.

## Common contributions

**A new rule for the catalogue.** Add it to [docs/use-cases.md](docs/use-cases.md). It must only use events and fields in `src/rules/catalogue.ts` and pass `checkRule`; the use-case tests check every rule in that file.

**A new field on an event.** Add it to the catalogue and make sure the adapter writes it into the normalized event. Rules may only read data Needl keeps.

**A new integration.** Add an adapter with the provider's real signing scheme, fixtures shaped from the provider's documentation (not captured traffic), catalogue entries, a simulator encoder and a section in [docs/providers.md](docs/providers.md).

## Pull requests

- Keep each PR focused on one change, with tests for new behavior.
- Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org/) style used in the history, for example `fix(rules): ...` or `feat(web): ...`.
- Update the docs when behavior changes.

By contributing you agree that your work is released under the [MIT License](LICENSE).
