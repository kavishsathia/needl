# Needl integrations and LTL runtime

`@needl/integrations` is a strict TypeScript package for authenticating webhook requests, turning selected provider events into evidence-bearing normalized observations, and monitoring those observations with a durable LTL runtime. It covers GitLab, Linear, LaunchDarkly, Sentry, PostHog, Intercom, and Stripe.

The package does not translate natural language, execute agents, or provide a frontend. Assertions are trusted configuration supplied as validated JSON AST; violations create transactional outbox requests for a future dispatcher but perform no external action.

## Design

The package keeps HTTP, provider parsing, and persistence separate:

```text
raw HTTP bytes + headers
          │
          ▼
tenant/provider route ──► tenant-specific keys
          │
          ▼
provider authentication ──► strict payload validation
          │
          ├── valid but unsupported/disabled ──► acknowledged ignored result
          │
          ▼
normalized observation ──► atomic scoped dedupe + durable sink ──► acknowledge
```

The monitor layer starts after durable normalization:

```text
normalized observation
        │
        ├──► explicit scope binding ──► tenant/assertion/version/entity partition
        │
        └──► state updates + proposition extraction ──► LTL progression
                                                       │
                                                       ├── checkpoint + full trace
                                                       └── counterexample + outbox
                                                           (one transaction)
```

Important properties:

- Signatures are verified against the original bytes before JSON parsing.
- Authentication never falls back implicitly. GitLab legacy token mode and PostHog custom-header mode must be selected explicitly.
- Current and prior secrets can be supplied as `secrets: [current, previous]` during rotation.
- Stable IDs and deduplication include tenant and provider scope. One tenant's delivery ID cannot suppress another tenant's event.
- `occurredAt` is distinct from receiver time. Missing provider timestamps remain missing.
- Relationships carry an `evidencePath`; the adapters do not infer that a mention, status, or co-occurrence proves a fix.
- Stored evidence defaults to a bounded provider projection, a raw-body SHA-256 digest, and safe absolute links. Exact authenticated JSON retention is an explicit `payloadRetention: "full"` option for callers with a controlled store; raw customer payloads and secrets are never logged by default.
- Valid unknown or unsubscribed events are different from malformed and unauthenticated requests.
- Propositions and state updates use a closed JSON predicate language. No JavaScript, regular expressions, or string evaluation is supported.
- Ordinary LTL finite prefixes have `satisfied`, `violated`, or `inconclusive` verdicts. Open eventualities do not time out. Complete finite-trace finalization is explicit.
- Deadline obligations are a named Needl timed extension driven by observation times and explicit ticks, not silently presented as ordinary LTL.
- Monitor partitions include tenant, assertion ID/version, and every configured correlation key. Missing bindings are ignored rather than guessed from timestamps.
- SQLite atomically stores input dedupe, checkpoints, complete traces, counterexamples, and deterministic pending outbox items.

See [provider coverage and setup](docs/providers.md) for exact event and security support.
See [LTL runtime semantics](docs/ltl-semantics.md) for the operator, prefix, finalization, state, ordering, correlation, evidence, and resource contracts.

## Requirements and installation

- Node.js 22.13 or later
- npm

```bash
npm install
npm run check
```

The runtime package has one portable dependency, Zod. SQLite is an optional subpath backed by Node's `node:sqlite`; importing the core or receiver does not load it.

## Use an adapter directly

```ts
import { LinearAdapter } from "@needl/integrations/adapters";

const adapter = new LinearAdapter();
const result = await adapter.ingest(
  {
    tenantId: "acme",
    sourceId: "linear-hook-production",
    rawBody, // Uint8Array containing the untouched request body
    headers,
    receivedAt: new Date(),
  },
  {
    secrets: [process.env.LINEAR_WEBHOOK_SECRET!],
    enabledEvents: ["Issue.create", "Issue.update"],
    kindMappings: { "Issue.update": "work.issue_changed" },
  },
);

if (result.status === "accepted") {
  // Persist result.event before acknowledging the provider.
}
```

Do not reserialize parsed JSON to reconstruct `rawBody`. Even equivalent JSON can produce a different signature.

## Use the receiver

`WebhookReceiver` resolves an adapter and its keys from `(tenantId, provider)`, enforces a payload limit, and acknowledges accepted input only after a `DeduplicatingEventSink` reports durable storage.

```ts
import {
  LinearAdapter,
  StaticRouteResolver,
  WebhookReceiver,
} from "@needl/integrations";
import { SqliteEventStore } from "@needl/integrations/sqlite";

const routes = new StaticRouteResolver().register(
  "acme",
  "linear",
  new LinearAdapter(),
  { secrets: [process.env.LINEAR_WEBHOOK_SECRET!] },
);

const store = new SqliteEventStore("./needl-events.sqlite");
const receiver = new WebhookReceiver({
  routes,
  sink: store,
  maxPayloadBytes: 1_048_576,
});

const outcome = await receiver.receive({
  tenantId: "acme",
  provider: "linear",
  rawBody,
  headers,
});

// Map outcome.statusCode to the HTTP response.
```

Receiver outcomes:

| Input/result | HTTP | Meaning |
| --- | ---: | --- |
| Stored or duplicate | 200 | Durable or already durably recorded |
| Valid ignored | 200 | Authenticated but unknown, disabled, or non-observational |
| Malformed | 400 | Authentication passed, schema did not |
| Missing/invalid/stale authentication | 401 | Do not process |
| Payload too large | 413 | Rejected before parsing |
| Unknown tenant/provider route | 404 | No keys or adapter exposed |
| Persistence failure | 503 | Not acknowledged; provider should retry |

`SqliteEventStore.list()` and `.replay()` read persisted observations in insertion order. Replay calls a consumer; it does not execute actions or mutate provider state.

## Define and run an assertion

The text parser is a convenience for human-authored ordinary LTL. A future authoring layer can emit the same typed JSON AST directly.

```ts
import {
  RuntimeMonitor,
  parseFormula,
  type AssertionDefinition,
} from "@needl/integrations/ltl";
import { SqliteMonitorStore } from "@needl/integrations/ltl/sqlite";

const assertion: AssertionDefinition = {
  id: "no-recurrence",
  version: 1,
  tenantId: "acme",
  name: "A deployed issue must not recur",
  formula: parseFormula("G (deployed -> G !recurrence)"),
  scope: {
    keys: [
      { name: "issue", extractors: [{ from: "relationship", type: "issue" }] },
      { name: "environment", extractors: [{ from: "relationship", type: "environment" }] },
    ],
  },
  propositions: [
    {
      name: "deployed",
      predicate: { op: "equal", path: { root: "event", segments: ["kind"] }, value: "fix.deployed" },
    },
    {
      name: "recurrence",
      predicate: { op: "equal", path: { root: "event", segments: ["kind"] }, value: "error.recurred" },
    },
  ],
};

const store = new SqliteMonitorStore("./needl-events.sqlite");
const monitor = new RuntimeMonitor({ store, assertions: [assertion] });
const results = await monitor.process(normalizedEvent);
```

`process()` applies every assertion registered for the event tenant. A result is `applied`, `duplicate`, `out_of_order`, `missing_scope`, or `closed`. A deadline is advanced with an explicit `advanceTime()` tick. `finalize()` closes one exact partition using the documented complete finite-trace semantics. New assertion versions create fresh partitions and never inherit prior state implicitly.

The reusable presets in `@needl/integrations/ltl` demonstrate three explicit correlation contracts:

- Linear Done + linked GitLab deployment, followed by matching Sentry recurrence;
- persisted LaunchDarkly enabled/disabled state + an explicitly attributed Sentry feature error; and
- Stripe payment + explicit PostHog provisioning failure, followed by a matching Intercom ticket within a deadline.

Provider adapters do not natively guarantee every cross-provider relationship used by these examples. The backend must attach a relationship only when it has explicit mapping evidence. The presets intentionally refuse unbound observations.

## Run the local HTTP example

Copy `.env.example` values into your own secret-management mechanism or shell environment. The example deliberately does not load `.env` files itself.

```bash
export NEEDL_TENANT_ID=local-demo
export LINEAR_WEBHOOK_SECRET='...'
# Set the remaining provider variables shown in .env.example.
npm run example
```

Routes are `POST /webhooks/:tenant/:provider`, for example `POST /webhooks/local-demo/stripe`. Configured Intercom routes also answer the unsigned `HEAD` validation request required during Intercom setup; other provider routes do not. `GET /healthz` is available for local checks. The server binds to `127.0.0.1`; this assignment does not deploy it or register webhooks.

The example registers all seven providers and persists to `NEEDL_DB_PATH` (default `./needl-events.sqlite`). It never logs bodies, signature headers, or secrets.

## Run the LTL demonstration

```bash
npm run demo:ltl
```

The command uses in-memory SQLite and clearly labeled synthetic normalized observations. It prints three real persisted counterexample records and their pending deterministic outbox requests. It contacts no provider and dispatches no external action.

## Tests and fixtures

Synthetic fixtures in [tests/fixtures](tests/fixtures/README.md) are shaped from cited provider documentation. They are not captured production traffic.

```bash
npm run typecheck
npm test
npm run build
npm run check
```

The integration tests cover documented signature algorithms, raw-body tampering, missing/wrong authentication, replay windows, malformed and unknown input, provider normalization, duplicate delivery, tenant separation, persistence failure/retry, SQLite restart/replay, and a signed HTTP request through real SQLite.

The LTL suites cover every operator, nested formulas, empty and complete traces, pending eventualities, strong next, deadline boundaries, malformed/injection-shaped ASTs, missing predicate paths, persistent state, repeated delivery, partition isolation, wrong/missing relationships, event-time regression, assertion versions, checkpoint restart, durable trace retention, SQLite outbox recovery, and all three cross-provider scenarios. Short traces are exhaustively checked against a separately implemented recursive evaluator rather than against progression itself.

## Package entrypoints

- `@needl/integrations` — adapters, contracts, and receiver
- `@needl/integrations/adapters` — provider adapters
- `@needl/integrations/receiver` — storage-independent routing and receiver contracts
- `@needl/integrations/sqlite` — optional local SQLite store
- `@needl/integrations/ltl` — formula, extraction, monitor runtime, memory store, and demo presets
- `@needl/integrations/ltl/sqlite` — optional durable monitor/checkpoint/trace/outbox store

## Repository map

- `src/core` — common event/result contracts and safe helpers
- `src/adapters` — seven provider implementations
- `src/receiver` — routing, acknowledgment, dedupe, memory, and SQLite implementations
- `src/ltl` — typed formulas, parser/formatter, predicates, progression, partitions, stores, and presets
- `examples/server.ts` — thin Node HTTP backend example
- `examples/ltl-demo.ts` — deterministic synthetic cross-provider monitoring demo
- `docs/providers.md` — setup, coverage, delivery, and source details
- `docs/ltl-semantics.md` — normative monitor semantics and operational policies
- `tests` — unit, persistence, and HTTP end-to-end tests
- `FINAL.md` — verified handoff and remaining limitations
