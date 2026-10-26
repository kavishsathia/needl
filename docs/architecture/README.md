# Architecture diagrams

Four diagrams of how Needl works today. Each has an editable SVG (plain shapes and text, no embedded fonts) and a PNG rendered from it at 2x.

| Diagram | What it shows | Where it lives in the code |
| --- | --- | --- |
| [Hands-off loop](01-hands-off-loop.svg) ([PNG](01-hands-off-loop.png)) | A rule set once, watched continuously; a break saves evidence and starts the chosen GitLab Duo flow; the draft MR is reviewed by the team; the rule keeps watching. | The whole path below |
| [Event pipeline](02-event-pipeline.svg) ([PNG](02-event-pipeline.png)) | One webhook from seven tools: authenticity check before parsing, the tool's own event name, live rules, store-once dedupe, and the answer the tool gets. | `apps/web/backend/ingestion.ts`, `src/receiver/receiver.ts`, `src/adapters/`, `NeedlRepository.store` / `processLiveEvent` / `storeEvent` in `apps/web/backend/repository.ts`, webhook route in `apps/web/backend/app.ts` |
| [Rule authoring and monitoring](03-rule-authoring-and-monitoring.svg) ([PNG](03-rule-authoring-and-monitoring.png)) | English to a checked rule (up to three repair attempts), paused for review, then progressed per issue or customer, with clock ticks for deadlines and the break saved in one transaction. | `apps/web/backend/translator.ts`, `src/rules/check.ts`, `src/rules/compile.ts`, `src/ltl/runtime.ts`, `apps/web/backend/monitor-store.ts`, `advanceDueMonitors` in `repository.ts` |
| [Duo response](04-duo-response.svg) ([PNG](04-duo-response.png)) | A stored break starts the configured flow at most once with the violation record in its instructions; Needl tracks the flow over GraphQL and shows the result on the rule; the team reviews the MR. | `apps/web/backend/investigations.ts`, `apps/web/backend/flow-connection.ts`, `launchPending` / `refreshRunning` calls in `app.ts` |

Nothing in these diagrams merges or deploys automatically: the default flow instructions say "Do not merge or deploy", and teams can switch automatic starts off and start a flow from a break by hand.
