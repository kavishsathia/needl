# Summary

**As of 2026-10-14:** GitLab 19.4 is the latest released version. Direct external flow launch exists at `POST /api/v4/ai/duo_workflows/workflows`; it is an **Experiment in 19.4** and marked GA in the live 19.5 documentation. GitLab says upcoming 19.5 features are already on GitLab.com, but Self-Managed remains version-dependent.

## Recommended path

1. Publish and enable a read-only Needl investigation flow in the AI Catalog.
2. Resolve its numeric `ai_catalog_item_consumer_id` with `aiCatalogConfiguredItems` GraphQL.
3. On each deduplicated violation, POST the Flows API with:
   - fixed server-side `project_id` and consumer ID;
   - compact `goal`;
   - `start_workflow: true`;
   - `allow_agent_to_request_user: false`; and
   - `additional_context` whose `Category` is `needl_counterexample` and whose `Content` is serialized JSON.
4. Persist workflow ID, returned catalog version, initial status, and `web_url` when present.
5. Poll owner-scoped GraphQL `duoWorkflowWorkflows` with the workflow global ID for status.
6. If the experimental `duo_flow_callback_hooks` feature is available, add a signed callback plus `client_reference` for push progress/final result. GitLab 19.5's MCP `start_duo_session`+`get_duo_session` is a supported alternative when its less expressive launch shape is sufficient.

Do **not** trigger through a Needl bot comment or assignment. GitLab explicitly blocks every configured trigger when the acting user is a bot, service account, or another flow.

## Main blockers

- Callback hooks are experimental, disabled by default, and documented as not production-ready.
- The Flows REST API exposes no general status GET, but GraphQL `duoWorkflowWorkflows` is a documented owner-scoped polling path. Rich final-message retrieval still relies on callbacks, MCP, or experimental checkpoint/trace data.
- No launch idempotency field is documented. Needl must deduplicate and treat ambiguous HTTP timeouts as `launch_unknown`, not blindly retry.
- Exact unattended service-account token/entitlement behavior is undocumented and must be tested.
- Request-level privilege arrays may not apply to catalog-consumer launches; use YAML toolsets, composite identity, membership, and verified governance.
- Input size/context limits, REST artifact enumeration, API cancellation, and custom-flow calls to external MCP servers are undocumented. MCP 19.5 returns limited created-resource metadata, not CI artifact enumeration.

## First test

Use a disposable GitLab project and a normal scoped test user. Validate a one-agent read-only ambient flow, enable it, look up the consumer ID, launch it through REST with one tiny counterexample and no callback, and poll its global ID through `duoWorkflowWorkflows`. Verify session/version/runner/tenant isolation and terminal state. Then test MCP separately. Only if the callback flag is enabled, repeat with a signing token and prove HMAC verification, duplicate handling, event ordering, and terminal delivery.

## Hackathon fit

Needl strongly fits Life After Code's post-code monitoring/governance theme. The current submission deadline is **2026-10-27 13:00 UTC**. Path B is viable only if the original project is MIT-licensed open source and the agentic automation plus deployment are new after October 5. The submission also needs a public GitLab repo, visible pipeline history, detectable MIT license, instructions/assets, and a public YouTube demo under three minutes.

No `examples/` YAML was created: this environment could not run the authoritative GitLab flow builder/catalog validator, and a merely syntax-valid YAML would not meet the brief's schema-validation requirement.
