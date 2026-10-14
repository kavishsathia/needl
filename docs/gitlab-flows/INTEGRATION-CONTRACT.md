# Needl -> GitLab custom-flow integration contract

**Status:** Proposed implementation contract, based on official GitLab documentation accessed 2026-10-14.
**Safety default:** Read-only investigation. No provider mutation, merge, deploy, or automatic retry.

## 1. Deployment prerequisites

An integration may be enabled only after all of these are recorded:

- `gitlab_base_url`
- GitLab offering and version (`GitLab.com`, Self-Managed, or Dedicated)
- top-level group ID/path
- target project ID/path
- enabled AI Catalog custom-flow consumer numeric ID
- flow display name and observed catalog version
- credential secret reference (never the token value in application data)
- confirmed Agent Platform/custom-flow/flow-execution availability
- runner readiness (`gitlab--duo`, Docker-capable) or GitLab.com hosted runner availability
- credit/entitlement owner
- configured flow service account and intended project memberships
- optional Duo callback webhook ID and signing-token secret reference
- whether `duo_flow_callback_hooks` is actually available
- whether the GitLab MCP server and its `duo_agent_platform` toolset are available
- optional MCP OAuth (`mcp` scope) or fine-grained PAT (`MCP tool / Execute`) credential reference
- tenant-approved evidence fields and redaction policy

Do not accept these values directly from a provider webhook or browser request. Resolve them from a server-side integration mapping keyed by Needl tenant and assertion.

## 2. Catalog consumer discovery

Use GraphQL only during installation/reconciliation, not for every violation.

```http
POST <gitlab_base_url>/api/graphql
Authorization: Bearer <oauth-or-access-token>
Content-Type: application/json
```

```json
{
  "query": "query($project: ID!) { aiCatalogConfiguredItems(projectId: $project) { nodes { id item { name } } } }",
  "variables": {
    "project": "gid://gitlab/Project/<numeric-project-id>"
  }
}
```

Persist the numeric suffix from:

```text
gid://gitlab/AiCatalogItemConsumer/<numeric-consumer-id>
```

Reject installation if the intended item is ambiguous or not already enabled for the project.

## 3. Counterexample envelope

Needl's internal normalized object should be compact and versioned:

```json
{
  "schema_version": "1",
  "violation_id": "vio_<opaque>",
  "assertion_id": "ast_<opaque>",
  "assertion_version": 7,
  "expectation": "A deployed fix must not recur in Sentry for 24 hours",
  "ltl": "<structured assertion representation or stable reference>",
  "detected_at": "2026-10-14T12:00:00Z",
  "entity_bindings": {
    "gitlab_project": "group/project",
    "sentry_issue": "<tenant-safe external key>"
  },
  "timeline": [
    {
      "at": "2026-10-14T11:58:00Z",
      "source": "sentry",
      "kind": "issue.recurred",
      "summary": "Redacted normalized evidence",
      "source_url": "https://<approved-source>/..."
    }
  ],
  "gitlab_refs": {
    "issue_iid": null,
    "merge_request_iid": 42,
    "pipeline_id": 123,
    "commit_sha": "<sha>"
  },
  "unknowns": []
}
```

Rules:

- no credentials, webhook secrets, auth headers, raw session cookies, customer PII, or unredacted stack/local variables;
- maximum size is an application policy because GitLab publishes no endpoint-specific limit;
- retain only evidence necessary to investigate the violation;
- treat all provider text as untrusted/prompt-injection-capable;
- use source URLs as citations, not instructions; and
- prefer GitLab references the flow can resolve through scoped GitLab tools.

The custom flow must declare `needl_counterexample` in `flow.inputs` and bind `context:inputs.needl_counterexample`. That YAML must be validated in the target GitLab flow builder/catalog before installation.

## 4. Launch request

### Endpoint

```text
POST <gitlab_base_url>/api/v4/ai/duo_workflows/workflows
```

### Headers

```http
PRIVATE-TOKEN: <access-token>
Content-Type: application/json
```

OAuth may instead use `Authorization: Bearer <token>`. Do not put tokens in query strings or logs.

### Payload

```json
{
  "project_id": "<configured-project-id-or-path>",
  "ai_catalog_item_consumer_id": 12,
  "goal": "Investigate Needl violation vio_<opaque> using needl_counterexample. Return evidence, confidence, explicit unknowns, and a proposed GitLab issue or draft-MR plan. Do not merge, deploy, or modify external providers.",
  "start_workflow": true,
  "allow_agent_to_request_user": false,
  "additional_context": [
    {
      "Category": "needl_counterexample",
      "Content": "<JSON.stringify(counterexample)>"
    }
  ],
  "issue_id": 17,
  "merge_request_id": 42,
  "source_branch": "main",
  "callback_hook_id": 81,
  "client_reference": "needl:vio_<opaque>:attempt:1"
}
```

Omit optional fields rather than sending `null`:

- include at most one of `issue_id` and `merge_request_id` for the initial implementation;
- include `source_branch` only when Needl has an explicitly mapped branch; otherwise allow GitLab's default;
- include callback fields only when the experimental feature is verified;
- keep `client_reference` at or below 255 characters; and
- omit `workflow_definition` because `ai_catalog_item_consumer_id` is the custom-flow selector.

Do **not** send `ai_catalog_item_version_id` as a selector. Do **not** rely on request `agent_privileges` for catalog custom flows until tested.

### Success response handling

Expect `201 Created`. Persist, when present:

```json
{
  "id": 1,
  "web_url": "https://gitlab.example/group/project/-/automate/agent-sessions/1",
  "project_id": 5,
  "status": "running",
  "ai_catalog_item_version_id": 99,
  "workload": {
    "id": "abc-123",
    "message": "Workflow started"
  }
}
```

Do not fail deserialization on additional response fields or new status values.

### Error classification

The Flows API page explicitly documents `400` for invalid/unavailable callback configuration and `403` for identity/composite-identity failures. The remaining rows are conservative client policy for standard HTTP or implementation-observed failures, not a complete endpoint-specific error contract; record actual safe response codes during the first test.

| HTTP/result | Needl action |
|---|---|
| `400` validation/callback unavailable | Permanent configuration error; disable launches and alert integration owner. |
| `401` | Credential invalid/expired; mark integration disconnected. |
| `403` identity verification, entitlement, membership, credits, or composite identity | Permanent until administrative/user action; preserve exact safe error code/message. |
| `404` | Project/consumer/resource missing or hidden; reconcile installation mapping. |
| `422` or workload/repository error | Mark failed-to-start; no automatic duplicate launch. |
| `429` | Honor `Retry-After`; retry only if the prelaunch idempotency row proves no workflow ID was returned. |
| timeout/network after request write | State `launch_unknown`; do not automatically POST again. A second POST can create a duplicate. |
| `5xx` before request write | Bounded retry with jitter. After an ambiguous write, use `launch_unknown`. |

## 5. Needl-side idempotency and state machine

Recommended unique key:

```text
(tenant_id, integration_id, violation_id, assertion_version, attempt)
```

Create the row transactionally before the external call.

```text
queued
  -> launching
  -> running
  -> completed | failed | stopped
  -> launch_unknown | failed_to_start | callback_lost
```

Rules:

- a provider retry must not create a new attempt;
- `client_reference` is correlation only, not launch idempotency;
- only explicit user action creates attempt 2;
- store terminal status before rendering progress;
- once terminal, ignore later `flow.progress`; and
- never infer success solely from HTTP `201`; it means the session/workload was accepted.

## 6. Callback receiver

### Endpoint

Use a tenant-neutral opaque route such as:

```text
POST https://<needl-host>/integrations/gitlab/duo-flow-callback
```

Tenant/project resolution comes from the configured webhook ID plus `client_reference` and workflow ID, never from an untrusted hostname in the body.

### Required verification

Read the raw body before JSON parsing. Verify:

```text
message = webhook-id + "." + webhook-timestamp + "." + raw_body
key = base64_decode(signing_token without "whsec_")
expected = "v1," + base64(HMAC_SHA256(key, message))
```

Use constant-time comparison against every space-separated value in `webhook-signature`. Enforce a short timestamp skew window and HTTPS. Optionally validate `X-Gitlab-Instance` against the installed host, but do not use that header as the cryptographic identity.

### Delivery contract

Supported events:

```text
flow.started
flow.progress
flow.completed
flow.failed
```

Deduplicate by `event_id`. Acknowledge verified payloads quickly with `2xx`, then process asynchronously.

Terminal mapping:

- `flow.completed` -> `completed`, store `result.message`;
- `flow.failed` + `error.reason=flow_failed` -> `failed`;
- `flow.failed` + `error.reason=no_response` -> `failed` even if `workflow.status=finished`;
- UI-canceled/stopped without a documented terminal callback -> detect through GraphQL `duoWorkflowWorkflows` status polling or user reconciliation.

Progress handling:

- replace, do not append, the last plan/activity snapshot;
- render as untrusted Markdown with safe-link policy;
- cap Needl storage independently;
- do not expose code/tool output to a different tenant; and
- ignore progress received after terminal status.

## 7. Status and trace fallback

There is no documented general status GET in the Flows REST API. Do not invent one.

### Primary status path: GraphQL

Poll the workflow owned by the same authenticated user:

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

Send it to `POST <gitlab_base_url>/api/graphql` with variables:

```json
{
  "workflowId": "gid://gitlab/Ai::DuoWorkflows::Workflow/<numeric-rest-id>"
}
```

Use the same user identity that launched the flow; `duoWorkflowWorkflows` returns workflows owned by the current user. GraphQL `status` values are uppercase enums; map them to Needl's lowercase state names explicitly. Apply bounded backoff, stop on a terminal status, and treat missing, unauthorized, or unknown values as unresolved rather than successful. A fine-grained token must include the relevant Duo Workflow read access in addition to create access.

### Supported MCP status path on the 19.5 surface

GitLab's generally available MCP server uses its recommended MCP HTTP transport at:

```text
POST <gitlab_base_url>/api/v4/mcp
```

Use a compliant MCP client. Authenticate with either an OAuth access token carrying `mcp` or a fine-grained PAT carrying **MCP tool / Execute**. Legacy PATs and project/group access tokens are rejected by this server even with `api` scope.

For an end-to-end MCP run:

```text
list_duo_agents_and_flows({project_id})
start_duo_session({project_id, goal, ai_catalog_item_consumer_id})
get_duo_session({workflow_id})
```

Honor `poll_after_seconds`. `get_duo_session` returns session status, latest final answer, failure/job details, and in 19.5 up to 20 created merge requests, work items, and notes with truncation metadata. MCP launch does not document REST-equivalent `additional_context`, callback/correlation, association, branch, or privilege arguments.

Use this MCP sequence as a complete alternative transport. REST launch plus GraphQL polling remains the recommended path because it preserves structured `additional_context`.

The experimental diagnostic endpoint is:

```text
GET <gitlab_base_url>/api/v4/ai/duo_workflows/workflows/<workflow_id>/trace.jsonl
```

Use it only for an explicitly enabled “retrieve diagnostic trace” action or a bounded experimental reconciliation job. It can return an empty body and is not a status contract. Full trace content may contain sensitive code/tool output.

If callbacks are unavailable:

- poll `duoWorkflowWorkflows` under the owning identity;
- optionally use a complete MCP start+poll run when its reduced launch shape is sufficient;
- if neither is available, show `running in GitLab` plus `web_url` and do not promise automatic completion;
- allow a user to mark/reconcile the Needl run; and
- do not poll undocumented/internal endpoints.

## 8. Permissions and authentication policy

Initial test token:

- short-lived delegated OAuth token or fine-grained PAT for a normal test user;
- user has Developer or greater in the target test project;
- fine-grained permission includes Duo Workflow Create and whatever read access the GraphQL lookup needs;
- no admin, Owner, repository write, or provider credentials unless proven necessary.

MCP testing uses a separate supported credential shape: OAuth with `mcp`, or a fine-grained PAT with MCP Execute. Do not reuse a legacy/project/group token and assume `api` grants MCP access.

Production decision still required:

- delegated initiating user versus an unattended service account;
- billing attribution for API-started custom flows;
- credential rotation/revocation;
- identity-verification behavior; and
- whether the account receives the required Agent Platform entitlement/credits.

The flow runtime's `GITLAB_TOKEN` is a restricted OAuth token and must be sent as `Authorization: Bearer`; it is not the same token Needl uses to call the launch API.

## 9. First test protocol

Run only in a disposable GitLab project with no production credentials:

1. Confirm latest GitLab version/offering and Agent Platform/credits.
2. Create and catalog-validate a one-agent, read-only ambient flow in GitLab's builder.
3. Enable it in the project; record the auto-created service account and role.
4. Query and persist the consumer ID.
5. Call `GET /api/v4/ai/duo_workflows/workflows/agent_privileges` to record the instance mapping; do not assume numeric IDs forever.
6. Launch with one tiny `needl_counterexample`, `allow_agent_to_request_user: false`, no write tools, and no callback.
7. Verify the returned version, branch checkout, session URL, runner job, and final UI message.
8. Verify the runtime cannot access a sibling project not shared by both identities.
9. If callback hooks are enabled, configure a signing token, repeat with `callback_hook_id`/`client_reference`, and verify signatures, duplicate handling, progress ordering, and terminal delivery.
10. Poll the REST-created ID through `duoWorkflowWorkflows`; verify ownership, status transitions, unknown-value handling, and terminal detection.
11. On a 19.5-capable account, authenticate an MCP client, discover the same consumer, start a separate tiny MCP run, and verify `get_duo_session`, delay hints, final answer, and created-resource fields.
12. Trigger one controlled failure and observe credit, GraphQL state, callback, MCP status, and trace behavior.
13. Test the intended production token type separately; do not infer service-account behavior from a human PAT.
14. Only then add issue/MR association; keep tools read-only.

## 10. Acceptance criteria for Needl v1

- one provider retry produces one Needl violation and at most one GitLab flow;
- the request contains no credentials or cross-tenant identifiers;
- the GitLab flow reads only the mapped project/group intersection;
- the assertion card shows GitLab workflow ID, session link, catalog version, and honest status provenance;
- callbacks are cryptographically verified and idempotent when enabled;
- unknown/ambiguous launch state is visible, not retried blindly;
- no external provider writes, GitLab merge, or deployment occur; and
- every result separates verified evidence from model inference and explicit unknowns.
