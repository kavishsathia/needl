# GitLab custom flows and external invocation research

**As of:** 2026-10-14 UTC
**Scope:** Source-grounded research for Needl. No live flow, webhook, issue, merge request, account, or deployment was created.
**Version baseline:** GitLab 19.4 is the latest released version as of this date. GitLab 19.5 is still the upcoming release, although GitLab says the 19.5 features are already available on GitLab.com. The current documentation is built from the development branch and includes 19.5 behavior; this report calls out that boundary.

## Executive finding

There is now a documented direct REST launch mechanism for an external backend:

```text
POST /api/v4/ai/duo_workflows/workflows
```

To launch an enabled custom flow, Needl supplies `project_id`, the numeric `ai_catalog_item_consumer_id`, a `goal`, `start_workflow: true`, and optionally `additional_context`. The consumer ID is discovered through the documented GraphQL `aiCatalogConfiguredItems` query. This is a direct invocation, not a webhook workaround.

The important maturity split is:

- **GitLab 19.4:** the Flows API is documented as **Experiment**. The API exists and its 19.4 documentation includes catalog flow execution and structured context. Callback hooks are also experimental and require the disabled-by-default `duo_flow_callback_hooks` flag.
- **GitLab.com during the 19.5 delivery window:** the upcoming-release page says 19.5 features are already available on GitLab.com, and the live API page marks flow triggering generally available in 19.5. Needl must still verify namespace availability and the callback flag in the actual account.
- **GitLab Self-Managed 19.4:** treat direct launch as experimental. The administrator can inspect/enable feature flags. Do not describe 19.5 GA until that version is actually installed.
- **GitLab Dedicated:** the Flows API is listed, but the callback documentation lists only GitLab.com and Self-Managed. Callback availability on Dedicated is therefore an explicit unknown.

The smallest Needl integration is REST launch plus the documented GraphQL `duoWorkflowWorkflows` query for status. That query accepts the workflow global ID and returns sessions owned by the authenticated user, including status and session metadata. The signed callback is an optional experimental push path, and the current 19.5 GitLab MCP server is a second end-to-end start/poll surface with richer final-result and created-resource output. There is no general REST status GET.

## 1. What a custom flow means now

### 1.1 Definition and lifecycle

A custom flow is a user-authored, multi-step AI workflow published to the GitLab AI Catalog. Custom flows became GA in GitLab 19.2. They run in the `ambient` environment and are designed for background delegation with minimal human interaction.

The REST response exposes these session states:

```text
created, running, paused, finished, failed, stopped,
input_required, plan_approval_required, tool_call_approval_required
```

GitLab may add states. Needl must treat unrecognized values as nonterminal rather than fail closed.

### 1.2 Flow Registry v1 configuration

GitLab's custom-flow schema page delegates the full syntax to the public Flow Registry v1 specification. At minimum, a flow has:

- `version: v1`
- `environment: ambient`
- `components`
- `routers`
- `flow.entry_point`
- inline `prompts` when a component references a locally defined prompt

The public v1 specification describes these component types:

- `AgentComponent`: iterative model reasoning with tools.
- `DeterministicStepComponent`: deterministic Python component registered by the platform.
- `OneOffComponent`: one model call, no tool loop.
- `HumanInputComponent`: pauses for user input or approval.
- `EndComponent` and `AbortComponent`: explicit terminal behavior.

Routers may be simple or conditional. Components exchange state through paths such as `context:goal`, `context:<component>.final_answer`, and aliases declared in `inputs`.

Custom-flow restrictions are material:

- only `environment: ambient` is supported;
- `model` in an inline prompt is rejected;
- `AgentComponent.response_schema_id` and `response_schema_version` are not supported;
- `OneOffComponent.ui_role_as` is not supported;
- prompt `params.stop` is not supported; and
- top-level `name`, `description`, and `product_group` are rejected.

The catalog's flow YAML limit is **40 KiB**. This is a configuration limit, not a documented launch-payload or LLM-context limit.

### 1.3 Components, tools, and permission surface

An `AgentComponent` declares a `toolset`. The v1 specification documents file, repository, GitLab API, Git, and command tools and points to the service's `components/tools_registry.py` as the complete implementation registry. Tool options can pin tool parameters, overriding model-supplied values.

There is a documentation gap: the user-facing “Agent tools” page is written for custom agents, not explicitly for custom flows, and the v1 specification does not provide a stable, exhaustive parameter contract for every tool. A GitLab public work item specifically records this gap. Therefore:

- use only tool names accepted by the flow builder/catalog validator;
- validate the exact YAML in the target GitLab version;
- do not treat names inferred from service source as a compatibility promise; and
- keep the Needl v1 investigation flow read-oriented until write behavior is tested.

The launch API exposes numeric `agent_privileges` and `pre_approved_agent_privileges`. The documented privilege lookup currently returns:

1. `read_write_files`
2. `read_only_gitlab`
3. `read_write_gitlab`
4. `run_commands`
5. `use_git`
6. `run_mcp_tools`

However, the public Rails source for the catalog-consumer execution branch constructs catalog execution parameters without forwarding the two privilege arrays. The documentation does not state whether these request fields are effective for an `ai_catalog_item_consumer_id` launch. Needl must not claim request-level privilege scoping for custom catalog flows until a non-production test proves it. Scope the flow principally through its YAML toolset, the service account's project membership, composite identity, and tool-governance policy.

Background tool-governance enforcement was introduced behind the disabled-by-default `duo_workflow_background_tool_governance` flag in 19.3. This means “Always Ask/Allow/Deny” for background custom flows must also be verified on the target namespace/version; do not assume the UI policy is enforced merely because it is configured.

### 1.4 Location, registration, versioning, and distribution

There is no single mandatory repository path for an AI Catalog custom flow:

- Items created in the UI are stored in the **AI Catalog**, not in the repository. A managing project controls editing and visibility.
- Flow definitions may be maintained in a repository and published with GitLab's AI Catalog CI/CD component. Its defaults use a `flows/` directory and tag pipelines; directory names are configurable.
- A trigger can point to a repository configuration such as `.gitlab/duo/flows/claude.yaml`, but the “Configuration path” option is behind `ai_catalog_create_third_party_flows`, disabled by default. This path-based trigger is not the recommended Needl invocation mechanism.
- `.gitlab/duo/` is also the conventional project directory for Agent Platform configuration. The executor configuration specifically lives at `.gitlab/duo/agent-config.yml` on the default branch.

Each catalog edit creates an immutable semantic version; GitLab automatically increments the minor version. Consumers are normally pinned:

- a group pins the latest version when enabling the item;
- a non-managing project pins the version used by its top-level group;
- the managing project normally tracks the latest version.

The direct launch selects the **configured consumer**, not an arbitrary version. Although the REST schema contains `ai_catalog_item_version_id`, the docs describe it as the version that *sourced* the flow configuration, not as the selector for an enabled catalog item. Needl should store the version returned by GitLab for audit but must not try to choose a version by sending that field. Change the consumer's pin through supported catalog administration instead.

Visibility controls distribution:

- public: enableable across eligible projects on the instance;
- restricted: available only inside the managing project's top-level group hierarchy;
- private: only the managing project can enable it.

For Needl, restricted visibility is the safest default when the managing and execution projects share a top-level group.

### 1.5 Supported platform triggers

GitLab 19.4 documents these trigger events for flows/external agents:

- mention of the flow service account in an issue or merge-request comment;
- assignment to an issue or merge request;
- reviewer assignment on a merge request;
- pipeline state: running, passed, failed, or canceled;
- merge request: approved, created, marked ready, or merge conflict; and
- work item: created or status changed.

These event types are distinct from GitLab's experimental cron scheduling surface. GitLab 19.4 introduced GraphQL `aiFlowScheduleCreate`, `aiFlowScheduleUpdate`, and `aiFlowScheduleDelete`; a schedule references an existing flow trigger by global ID and has a cron expression, IANA timezone, description, and active flag. This can schedule a trigger, but it is configuration-time automation rather than an inbound event carrying a Needl counterexample. The public user trigger page does not yet describe schedule setup or its runtime identity/credit behavior, so validate it separately before production use.

For the listed **event** triggers, all event types require a human user action. GitLab explicitly says bot users, service accounts, and another flow cannot activate them. A Needl service-account comment or assignment is therefore not a valid automatic launch design.

Trigger input differs from a direct launch. The custom-flow schema page documents a full comment plus resource context for mentions, a bare resource IID for assign/reviewer events, and the full pipeline webhook payload for pipeline events. The current trigger page instead says non-mention events receive a short context block with resource/project URL and action. Those two official pages are inconsistent for assign/reviewer and pipeline input; validate the chosen trigger on the target version and do not build Needl's direct integration around either format. The schema page does not give precise `context:goal` formats for the newer MR/work-item events.

An optional per-condition trigger goal, introduced behind `ai_flow_trigger_goals` in 19.5, is prepended and is limited to 4,096 characters. This trigger-only limit is not a documented REST `goal` limit.

Direct REST launch does not use those event-specific formats; Needl supplies its own `goal` and declared additional context.

## 2. Exact external invocation mechanisms

### 2.1 Supported direct mechanism: Flows REST API

For a custom flow already enabled in the target project:

1. Find its consumer through GraphQL:

```graphql
query {
  aiCatalogConfiguredItems(projectId: "gid://gitlab/Project/<project_id>") {
    nodes {
      id
      item { name }
    }
  }
}
```

The returned ID is `gid://gitlab/AiCatalogItemConsumer/<numeric_id>`. Use only the numeric suffix in the REST request.

2. Launch it:

```http
POST https://<gitlab-host>/api/v4/ai/duo_workflows/workflows
PRIVATE-TOKEN: <access-token>
Content-Type: application/json

{
  "project_id": "<numeric-id-or-path>",
  "ai_catalog_item_consumer_id": <numeric-consumer-id>,
  "goal": "Investigate Needl violation <opaque-id> using the supplied counterexample. Report evidence and a proposed next action; do not merge or deploy.",
  "start_workflow": true,
  "allow_agent_to_request_user": false,
  "additional_context": [
    {
      "Category": "needl_counterexample",
      "Content": "{\"schema_version\":\"1\",\"violation_id\":\"...\"}"
    }
  ]
}
```

`Content` is a string containing serialized JSON; it is not a nested JSON object. The flow must declare a matching `flow.inputs` category and schema, then bind `context:inputs.needl_counterexample` into the component prompt. Otherwise the context is not a reliable input contract.

The API returns `201` and includes a workflow `id`, initial `status`, workload data, selected privileges, catalog version ID, and—on the live 19.5 docs—a `web_url`. The 19.4 stable response table does not document `web_url`, so Needl should tolerate it being absent and construct no undocumented UI URL.

### 2.2 Supported 19.5 mechanism: GitLab MCP server

The generally available GitLab MCP server is a second supported external surface at:

```text
POST https://<gitlab-host>/api/v4/mcp
```

Use a compliant MCP client over GitLab's recommended HTTP transport rather than treating this as an ordinary one-shot REST endpoint. Authentication is either an OAuth access token with the `mcp` scope or a fine-grained PAT with **MCP tool / Execute** permission. Legacy PATs, project access tokens, and group access tokens are explicitly rejected even if they have `api` scope.

GitLab 19.5 documents this exact tool sequence:

1. `list_duo_agents_and_flows({project_id})` discovers enabled flows. A runnable custom flow has `can_start_session: true` and supplies its project-specific `ai_catalog_item_consumer_id`.
2. `start_duo_session({project_id, goal, ai_catalog_item_consumer_id})` starts the custom flow asynchronously and returns `workflow_id` plus `poll_after_seconds`.
3. `get_duo_session({workflow_id})` returns status and a polling hint; when finished, it returns the latest agent answer. In 19.5 it also returns up to 20 created merge requests, work items, and notes, with truncation metadata, plus failure reason/job URL when applicable.
4. `send_duo_session_input` can answer or approve a paused session, but Needl v1 should avoid interactive checkpoints.

`start_duo_session` was introduced in 19.5; `get_duo_session` was introduced in 19.4 and expanded in 19.5. The 19.5 release features are already deployed to GitLab.com; Self-Managed and Dedicated need the installed release and enabled MCP/Agent Platform prerequisites.

This surface is less expressive for Needl's initial launch. It has no documented arguments corresponding to REST `additional_context`, `callback_hook_id`, `client_reference`, issue/MR association, source branch, or privilege arrays. Needl would have to put a compact counterexample into `goal`. REST plus GraphQL status polling therefore remains the recommended contract; MCP is a credible complete alternative.

GitLab warns that an MCP-started session runs in CI and can push commits or open merge requests. The selected custom flow must still be deliberately read-only for Needl v1; using MCP does not make the run observational by default.

### 2.3 Other mechanisms and their classification

| Mechanism | Classification | Needl assessment |
|---|---|---|
| `POST /api/v4/ai/duo_workflows/workflows` with catalog consumer | Direct, documented | Recommended. Experiment in 19.4; GA-labelled in 19.5 docs. |
| GitLab MCP `start_duo_session` | Direct, documented in 19.5 | Supported custom-flow launch and polling path. Less launch context/control than REST; requires MCP OAuth or fine-grained PAT. |
| Human mention/assign/reviewer action | Native trigger | Supported, but not automatic from Needl. Useful fallback requiring a human click/comment. |
| Needl bot/service-account comment or assignment | Explicitly blocked trigger | Do not implement as a launch path. |
| Pipeline event trigger | Native trigger | Supported for qualifying human-caused events, but not an inbound API for arbitrary Needl payloads. |
| GraphQL `aiFlowScheduleCreate` | Native cron schedule, Experiment | Schedules an existing flow trigger. Useful for periodic work, not an event-driven Needl payload path. |
| Scheduled pipeline | Workaround, not a documented scheduled flow | Could run client code, but job-token support for the Flows API is not documented and it does not solve event-driven Needl launches cleanly. |
| GitLab Duo CLI headless `run --goal` | Supported CLI automation | Runs supported CLI/foundational flows in its own execution model; not the documented way to select an enabled custom catalog consumer. |
| Outgoing GitLab webhook | Notification only | Normal project/group webhooks do not start a flow. Duo flow callbacks report lifecycle after a REST launch. |
| Internal workflow checkpoints/WebSocket/resume routes found in source | Internal/unsupported unless separately documented | Do not integrate. Public source does not make an endpoint a supported customer contract. |

### 2.4 GraphQL session, status, and schedule surfaces

GitLab's generated GraphQL reference documents the experimental `aiDuoWorkflowCreate` mutation. It creates a workflow/session record and accepts `projectId` or `namespaceId`, `goal`, privilege arrays, `workflowDefinition`, issue/MR IID, and an `aiCatalogItemVersionId` global ID. It does **not** accept a catalog consumer ID, `additionalContext`, `startWorkflow`, callback/correlation fields, or source branch. The docs say “created workflow,” not that a CI workload is started. It is therefore not a documented one-call replacement for the REST custom-flow launch.

GraphQL is useful after REST launch. `duoWorkflowWorkflows(workflowId: ...)` lists workflows owned by the current user and can return `status`, `statusName`, `statusGroup`, `webUrl`, `summary`, title, timestamps, and catalog version. The numeric REST workflow ID maps to the global ID form `gid://gitlab/Ai::DuoWorkflows::Workflow/<id>`. `duoWorkflowEvents` is an experimental checkpoint/event query and can be paged, but full checkpoint content should be treated as sensitive.

GraphQL also exposes the experimental cron schedule mutations described in section 1.5. None of these GraphQL operations offers launch idempotency; GraphQL `clientMutationId` is client correlation, not a documented deduplication guarantee.

## 3. Context, project/ref, association, versions, and size

### Supported request controls

- **Structured context:** `additional_context[]` with `Category` and serialized-JSON `Content`.
- **Project:** `project_id` accepts ID or path.
- **Namespace:** `namespace_id` exists, but catalog flows require project context.
- **Source branch:** `source_branch`; live docs clarify it applies only when the flow runs in CI. For a normal custom flow, the project default branch is the default.
- **Issue association:** `issue_id` is the issue IID and requires `project_id`.
- **Merge-request association:** `merge_request_id` is the MR IID and requires `project_id`.
- **Flow selection:** `ai_catalog_item_consumer_id` for an enabled catalog flow.
- **Version observation:** `ai_catalog_item_version_id` in the response.
- **Interaction:** `allow_agent_to_request_user`; use `false` for an unattended Needl run unless Needl implements resume/approval.

### Important limitations

- `issue_id`/`merge_request_id` **associate** the session. The docs do not promise that merely setting one loads all resource content into a custom flow; include the identifiers/URLs in the goal/context and give the flow the required GitLab read tools.
- `source_branch` is a branch string, not a documented arbitrary commit-SHA or generic ref selector. There is no request field for target branch or commit pin.
- A catalog consumer controls the version in the recommended REST launch. The experimental GraphQL create mutation accepts an `aiCatalogItemVersionId`, but does not document starting the background CI workload; it is not a supported REST version override.
- No endpoint-specific maximum is documented for `goal`, the number/size of `additional_context` entries, total request size, or model context. The only precise input-related maximum found is 40 KiB for the stored flow YAML.
- The Flow Registry v1 spec has a soft default of 280 agent cycles and a graph recursion default of 600 transitions, but these are engine limits, not a wall-clock SLA. Prompt `timeout` is per model request. The total flow timeout ultimately also depends on the CI job/runner configuration.

Needl should send a compact, normalized counterexample, not raw provider payloads. Large logs should be reduced to relevant excerpts and stable URLs. Because remote flow egress is sandboxed, external URLs to Linear, LaunchDarkly, or Sentry are not guaranteed to be fetchable.

## 4. Authentication, authorization, identity, and secrets

### 4.1 Caller authentication

The Flows API examples use:

```http
PRIVATE-TOKEN: <your_access_token>
```

GitLab's generic REST authentication supports OAuth 2.0, personal, project, and group access tokens, but endpoint-specific documentation does not explicitly certify every token type for flow creation. A normal scoped PAT or delegated user OAuth token is the conservative first test. A legacy token that performs POST requests normally needs `api`; a fine-grained PAT exposes the user-bound **Duo Workflow / Create** permission for this route.

Do not assume a CI job token works: job tokens are accepted only by specifically supported endpoints, and the Flows API does not document job-token authentication.

The API-specific minimum project role is not stated on the API page. Custom-flow UI execution requires Developer, Maintainer, or Owner, and the item must already be enabled for the project. Treat Developer as the minimum candidate and verify the exact caller in a test namespace.

### 4.2 Composite identity and tenant boundary

Enabling the flow creates a service account in the top-level group and adds it to the project with Developer access. At execution, GitLab uses a one-time composite identity combining the initiating user and the flow service account. The more restrictive role wins. The flow can access only projects accessible to both identities.

The `enforce_composite_identity_for_api_started_workflows` flag was introduced in 19.4 and is disabled by default. When enabled with `start_workflow: true`, GitLab requires a configured catalog service account or the service account behind the request's composite identity and otherwise returns `403`.

For Needl:

- store credentials per GitLab installation/top-level-group tenant;
- never let a request select an arbitrary GitLab host, project, consumer, or webhook ID outside its server-side tenant mapping;
- ensure the flow's service account belongs only to intended projects;
- prefer a delegated human OAuth identity if the product UX has a responsible initiating user;
- if fully machine-to-machine service-account authentication is required, treat it as **untested** for entitlement/composite-identity behavior and prove it in the first test; and
- expect `403` for required GitLab identity verification.

### 4.3 Runtime tokens and secret handling

Inside an AI Catalog flow, GitLab supplies an OAuth token restricted to the `ai_workflows` and `mcp` scopes. Custom flow scripts must send it as `Authorization: Bearer $GITLAB_TOKEN`; using `PRIVATE-TOKEN` with that runtime OAuth token returns `401`. The CI job token has a distinct, more restricted permission set.

Custom project/group/instance CI/CD variables are not available in flow jobs. For third-party authentication, current docs recommend OIDC ID tokens configured in `.gitlab/duo/agent-config.yml`, combined with a narrow network allowlist. This is preferable to embedding a Needl API secret.

Security warning: `setup_script` runs before the sandbox and can see triggering-user OAuth tokens, service tokens, and identity data. Protect `.gitlab/duo/agent-config.yml` on the default branch with reviews/CODEOWNERS and avoid echoing environment variables.

### 4.4 Approval and tool controls

There are several different controls; they are not interchangeable:

- YAML `toolset`: what the agent can attempt.
- Service-account membership plus composite identity: which GitLab resources it can reach.
- Tool governance: Always Allow/Ask/Deny at execution time; background enforcement is feature-flagged in 19.4.
- REST `agent_privileges` and `pre_approved_agent_privileges`: documented request fields, but their effect on the catalog-consumer branch is not established.
- `HumanInputComponent`: explicit flow checkpoint visible in Sessions.
- `allow_agent_to_request_user`: whether the agent may stop for questions.

For the first Needl flow, omit all write tools and set `allow_agent_to_request_user: false`. Add issue/MR writes only after approval behavior is proven.

## 5. Runtime, network, models, MCP, and cost

### 5.1 Execution location and runner

Flows launched from the GitLab UI/API for background execution use CI/CD. The runner downloads the GitLab Duo CLI executor, connects to the Duo Workflow Service over WebSocket, and executes file/Git/command tools as directed by the model.

On GitLab.com, hosted runners are available by default unless group IP restrictions make them unsuitable. A self-managed runner must:

- be an instance runner or top-level group runner by default;
- have the `gitlab--duo` tag;
- use Docker, Docker Autoscaler, or Kubernetes (not shell); and
- reach GitLab and Agent Platform services.

The default image is UBI 9 Minimal based, runs as root, and includes common runtimes plus SRT. Custom images must meet GitLab's requirements. Sandbox isolation requires SRT and compatible namespace capabilities; GitLab explicitly warns that execution can fall back unsandboxed if the runner cannot create namespaces.

`coding_environment: full` clones the repository and prepares setup/cache. `none` skips that preparation, but it does not block repository access—an agent with `run_command` can clone manually. The Needl investigation flow needs `full` if it will inspect or change repository files.

### 5.2 Network and external services

Remote flows are sandboxed; SRT blocks external communication except allowed destinations. `agent-config.yml` provides `network_policy.allowed_domains`. This means a Linear/LaunchDarkly/Sentry URL in Needl context is evidence, not proof the flow can fetch it.

The minimal design passes provider facts into `needl_counterexample` and lets the flow inspect GitLab only. A later design can use OIDC plus an allowed Needl domain to fetch a short-lived, tenant-scoped evidence bundle, but that adds network and credential risk.

### 5.3 Model selection

Custom-flow prompt YAML cannot contain `model`. GitLab says the model comes from group or instance configuration. The live model-selection page is the current source for defaults and compatible alternatives.

The official pages are internally inconsistent on the exact current default: the general Flows page still labels flows with Claude Sonnet 4, while the model-selection page says “all other agents” moved to Claude Sonnet 5.5 Gemini Enterprise Agent Platform on 2026-10-07. Do not hard-code or advertise a specific model for the Needl custom flow; inspect the target namespace setting.

### 5.4 MCP: two different directions

The GitLab MCP server is an external, authenticated interface into GitLab and, in 19.5, can launch and track custom flows as described in section 2.2. That is distinct from a GitLab custom flow acting as an MCP client to call some other server.

For the latter direction, the MCP client documentation explicitly lists Agentic Chat and the Software Development Flow as clients for external MCP servers; it does not promise arbitrary custom background flows can use those servers. The launch response/privilege list contains `mcp_enabled` and `run_mcp_tools`, but those fields alone do not establish custom-flow-to-external-MCP support. Treat that capability as unknown and unnecessary for Needl v1.

### 5.5 Cost

Agent Platform usage requires GitLab Credits unless covered by the relevant Duo entitlement. Most agentic usage is billed per model call; a flow can make many calls. The service account is the billing subject for trigger-started flows, and non-human subjects do not receive included credits. API-started catalog-flow billing attribution is not explicitly documented; verify it in the usage dashboard.

Runner compute-minute consumption is separate from model credits. No fixed custom-flow cost or maximum call count is documented.

## 6. Observability, completion, retry, and idempotency

### 6.1 Launch response and UI

Persist from the `201` response:

- GitLab host and project;
- workflow ID;
- workload ID/message if present;
- initial status;
- catalog version ID;
- session `web_url` if present; and
- the Needl violation/run ID used for correlation.

Sessions and CI job logs are visible under **AI > Sessions**. Sessions are deleted 30 days after last activity.

### 6.2 Callback path

With `duo_flow_callback_hooks` enabled, configure a project/group webhook for Duo flow callbacks and send:

- `callback_hook_id`; and
- `client_reference` (opaque, maximum 255 characters).

Events are:

- `flow.started`
- `flow.progress`
- `flow.completed`
- `flow.failed`

Terminal callbacks include workflow ID/status and UI URL; completion includes `result.message`; failure includes `error.reason` (`flow_failed` or `no_response`). Progress contains the full current plan (up to 20 items, each description truncated to 200 characters) and latest activity (truncated to 1,500 characters). Progress can include code/tool output and should be treated as sensitive.

Use GitLab webhook signing tokens. Verify HMAC-SHA256 over:

```text
{webhook-id}.{webhook-timestamp}.{raw-body}
```

Strip the `whsec_` prefix and Base64-decode the signing key. Compare `v1,<base64 digest>` in constant time and reject stale timestamps.

Delivery behavior:

- terminal events can be duplicated;
- failed terminal delivery is retried up to five times with backoff;
- retries reuse `event_id`;
- progress is not retried;
- events may arrive out of order; ignore progress after a terminal event.

The callback feature remains **Experiment**, is flag-gated, and GitLab says it is not ready for production use.

### 6.3 Polling and trace

The public Flows REST API does **not** document a general `GET /workflows/:id` status endpoint. Use the documented GraphQL endpoint with the same user that owns the REST-created workflow:

```graphql
query NeedlFlowStatus($workflowId: AiDuoWorkflowsWorkflowID!) {
  duoWorkflowWorkflows(workflowId: $workflowId) {
    nodes {
      id
      status
      statusName
      statusGroup
      webUrl
      summary
      title
      updatedAt
      aiCatalogItemVersionId
    }
  }
}
```

Pass `gid://gitlab/Ai::DuoWorkflows::Workflow/<numeric-rest-id>` as `workflowId`. GraphQL `status` is an uppercase enum (`RUNNING`, `FINISHED`, and so on), while REST/callback values are lowercase; normalize them deliberately. An empty result or authorization error must not be interpreted as completion. Poll with bounded backoff and stop on a terminal status; unknown status values remain nonterminal.

For checkpoint/message diagnostics, GitLab documents the experimental GraphQL `duoWorkflowEvents(workflowId: ...)` connection. The experimental REST trace route is:

```text
GET /api/v4/ai/duo_workflows/workflows/:workflow_id/trace.jsonl
```

It returns `ui_chat_log` JSONL and can be empty before checkpoints exist. It is useful for diagnostics/final transcript retrieval, but is not a documented status-polling contract.

The GitLab MCP server also documents status polling through `get_duo_session({workflow_id})`. It returns the latest answer at completion and, in 19.5, up to 20 created merge requests, work items, and notes. This is a supported MCP tool, not a REST route. Use it naturally for MCP-started runs; GraphQL is the documented owner-scoped status path for REST-created workflows.

No public REST artifact-list endpoint tied to a flow was found. Normal GitLab CI/job/artifact APIs may apply if relevant pipeline/job identifiers are known, but the REST launch response does not document those identifiers. MCP's created-resource lists are not CI artifact enumeration. Link users to `web_url` rather than invent an artifact URL.

### 6.4 Cancel, restart, retry, and idempotency

- Cancellation is documented in the UI. No public cancel REST endpoint is documented. Experimental GraphQL `deleteDuoWorkflowsWorkflow` deletes a session; its docs do not describe it as cancellation, so do not substitute it for a cancel operation without testing lifecycle effects.
- The live 19.5 API docs add an experimental restart endpoint for failed/stopped project flows. It creates a new workflow ID and restarts from the beginning. This endpoint is absent from the 19.4 stable API docs.
- There is no documented launch idempotency key. `client_reference` is only callback correlation and does not deduplicate launches.

Needl must own launch idempotency. Use a unique database constraint such as `(tenant_id, violation_id, assertion_version, integration_id, attempt)`; write a `launching` row before the HTTP call; and reconcile ambiguous timeouts manually because a retry may create a second flow.

## 7. Recommended smallest end-to-end integration

```text
Provider signed event
  -> Needl verifies, normalizes, and deduplicates
  -> LTL evaluation emits immutable violation/counterexample
  -> Needl maps tenant + entity to a fixed GitLab project and catalog consumer
  -> Needl POSTs the Flows API with compact additional_context
  -> GitLab returns workflow ID/session link
  -> Needl polls owner-scoped GraphQL duoWorkflowWorkflows for status
  -> optional signed callback supplies push progress/final result
  -> Needl assertion card links the GitLab session and shows terminal summary
```

Recommended v1 behavior:

1. **Investigation only.** Read repository, commits, merge requests, issues, and pipeline evidence. Do not merge, deploy, or mutate provider systems.
2. **No external fetch.** Needl sends normalized Linear/LaunchDarkly/Sentry evidence in the counterexample. The flow uses GitLab APIs/repository tools.
3. **Unattended completion.** Set `allow_agent_to_request_user: false`; no `HumanInputComponent` in v1.
4. **Read-only tools.** Return a final Markdown report with evidence, confidence, likely change, and recommended next step.
5. **Link, do not duplicate.** Store the GitLab session URL/ID and a short final result on the Needl assertion card; do not ingest full traces by default.
6. **Add writes later.** A v2 may create a GitLab issue or draft MR, gated by tested tool governance and an explicit tenant setting.

### Fallback when callbacks are unavailable

Poll `duoWorkflowWorkflows` by workflow global ID under the same owning user. This gives Needl a documented status path without the experimental callback, although it does not provide the callback's `result.message`. Use `summary` only when present; for a richer final answer, use an MCP-started run with `get_duo_session`, or explicitly opt into the experimental checkpoint/trace surfaces.

If GraphQL polling is unavailable in the target version/account, persist the REST response and mark the Needl card `investigating in GitLab` with the session link. Do not claim automatic completion.

If direct API launch itself is unavailable, the fully supported fallback is human activation: Needl creates or links to a GitLab issue using the normal Issues API, displays exact instructions, and a human mentions/assigns the flow account. A Needl bot cannot perform that triggering action. This fallback is not hands-off automation.

## 8. Proposed investigation flow behavior

This is a design, not a claim of live execution.

### Input contract

Needl supplies:

- assertion ID and immutable version;
- violation/counterexample ID;
- evaluated LTL expectation and human-readable expectation;
- tenant-safe entity bindings;
- ordered timeline of normalized events;
- source references and URLs;
- GitLab project, known issue/MR/commit/pipeline references; and
- provider evidence excerpts with secrets removed.

### Investigation steps

1. Validate required context fields and state any missing evidence.
2. Classify the counterexample as one of:
   - Linear ticket state/age contradiction;
   - LaunchDarkly flag rollout/change contradiction;
   - Sentry recurrence/regression contradiction; or
   - mixed/unknown.
3. Resolve linked GitLab commits, MRs, pipelines, deployments, issues, and blame/history using read tools.
4. Build a timestamped evidence chain. Distinguish observed facts, inferred causal links, and missing data.
5. Identify the smallest plausible remediation:
   - issue with reproduction/evidence;
   - draft MR plan and likely files/tests; or
   - “no code change justified” with operational next step.
6. Return a bounded final report containing:
   - finding;
   - evidence links;
   - confidence;
   - proposed issue/MR title and body;
   - recommended owner/action; and
   - explicit unknowns.
7. In a later write-enabled version only, create a GitLab issue or draft MR. Never merge, deploy, change a flag, close a Sentry issue, or update Linear without a separately designed approval boundary.

### Three concrete examples

**Linear ticket:** Needl reports that `ENG-123` remained “In Progress” beyond the assertion bound while its linked MR merged. The flow inspects the MR, merge commit, deployment pipeline, and related GitLab issue; it reports whether the likely failure is process synchronization, missing automation, or an incomplete code path. It proposes an issue, not a Linear mutation.

**LaunchDarkly flag:** Needl reports that a flag stayed enabled after a rollback condition. The flow inspects GitLab changes around the flag key, rollout configuration committed in the repo, deployment jobs, and rollback MRs. It recommends a GitLab issue or draft patch to code/config only when evidence supports it; it does not call LaunchDarkly.

**Sentry recurrence:** Needl reports recurrence after a fix MR. The flow inspects the fix diff, subsequent commits, relevant tests, deployment pipeline, and release references. It proposes a regression issue or draft test/fix plan with source links; it does not claim access to Sentry beyond the evidence Needl supplied.

## 9. Hackathon relevance

The current Life After Code hackathon runs through **2026-10-27 13:00 UTC**. Needl is highly aligned with the stated theme: monitoring and governed post-code automation across the monitor/govern/plan/create/verify stages.

Key requirements affecting Needl:

- every entry must use GitLab Duo Agent Platform features;
- Path A must be new work created on or after 2026-10-05;
- Path B starts from an existing **MIT-licensed open-source** project, adds the agentic automation during the submission period, and requires a public deployment;
- the submission needs a public GitLab repository, detectable MIT license, instructions/assets, and visible pipeline history showing the automation;
- the video must be public on YouTube and under three minutes; and
- Path B must link the original MIT project and keep the deployment available through the winner announcement.

Needl appears to fit Path B only if the original project is MIT-licensed open source and the GitLab automation plus deployment are new after October 5. If either fact is false, do not claim Path B eligibility; a truly new Path A project cannot simply relabel pre-existing Needl work. The repository license, creation history, deployment date, contributor registration, and entrant eligibility remain prerequisites to verify outside this research.

## 10. Explicit unknowns and blockers

1. Whether `duo_flow_callback_hooks` is enabled for the intended GitLab.com namespace; it is disabled by default and experimental.
2. Whether GitLab Dedicated supports Duo flow callbacks; the callback page omits Dedicated.
3. Exact token type/role combination intended for a fully unattended external service. PAT/OAuth examples are clear; service-account/project-token entitlement behavior is not.
4. Whether REST `agent_privileges` and `pre_approved_agent_privileges` affect catalog-consumer launches. Current public Rails source suggests they are not forwarded in that branch.
5. Endpoint-specific size limits for `goal`, `additional_context`, and total model input.
6. A supported REST status-polling endpoint. None is documented; the supported owner-scoped polling path is GraphQL `duoWorkflowWorkflows`.
7. A supported REST cancellation endpoint. None is documented; GraphQL deletion is not documented as cancellation.
8. Stable CI artifact enumeration for a flow. None is documented. MCP 19.5 returns limited created GitLab resources, not CI artifacts.
9. Launch idempotency. No request idempotency field is documented.
10. External MCP support for arbitrary custom background flows. Not documented.
11. Exact default model, due to inconsistent official flow/model pages; group/instance selection controls it.
12. Full stable tool parameter documentation for custom flows.
13. Exact event-trigger goal format where the current trigger page conflicts with the custom-flow schema page.
14. Needl's hackathon path eligibility, original MIT license, project dates, and deployment date.

## 11. Example-validation decision

No file was created under `examples/`. The official flow builder/catalog validator is the authoritative validation surface, and this research environment has no authorized GitLab project in which to validate a flow. A locally YAML-parseable example would not satisfy the brief's requirement for a schema-validated example. The integration request shape in `INTEGRATION-CONTRACT.md` uses only fields documented by the Flows API, but it is intentionally not represented as a validated custom-flow YAML.
