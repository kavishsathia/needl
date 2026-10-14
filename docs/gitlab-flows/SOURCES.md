# Sources and evidence log

All sources were accessed **2026-10-14 UTC**. Primary sources are official GitLab documentation, immutable GitLab public source snapshots, and the official Devpost rules page linked by GitLab. Short evidence notes are paraphrases unless quotation marks are used.

## Version and release boundary

1. **GitLab What's New**
   https://about.gitlab.com/whats-new/
   Evidence: identifies GitLab 19.4, released 2026-09-17, as the latest monthly release on the access date.

2. **GitLab 19.5 upcoming release**
   Landing page: https://docs.gitlab.com/releases/upcoming/
   Release page: https://docs.gitlab.com/releases/19/gitlab-19-5-released/
   Evidence: labels 19.5 upcoming; the release page states its features are already available on GitLab.com and specifically lists the Flows trigger API as GA plus new MCP flow/session tools. This is why GitLab.com and Self-Managed 19.4 are treated separately.

3. **Immutable GitLab 19.4 stable documentation snapshot**
   Commit: `20b069154492c5f1dcab66552f4e88f30b844463` (branch snapshot observed 2026-10-14)
   API doc: https://gitlab.com/gitlab-org/gitlab/-/blob/20b069154492c5f1dcab66552f4e88f30b844463/doc/api/duo_agent_platform_flows.md
   Custom flows: https://gitlab.com/gitlab-org/gitlab/-/blob/20b069154492c5f1dcab66552f4e88f30b844463/doc/user/duo_agent_platform/flows/custom.md
   Schema: https://gitlab.com/gitlab-org/gitlab/-/blob/20b069154492c5f1dcab66552f4e88f30b844463/doc/user/duo_agent_platform/flows/custom_flows_schema.md
   Triggers: https://gitlab.com/gitlab-org/gitlab/-/blob/20b069154492c5f1dcab66552f4e88f30b844463/doc/user/duo_agent_platform/triggers/_index.md
   Callbacks: https://gitlab.com/gitlab-org/gitlab/-/blob/20b069154492c5f1dcab66552f4e88f30b844463/doc/user/duo_agent_platform/flows/webhook_callbacks.md
   Evidence: 19.4 calls the launch API an Experiment; contains catalog consumer invocation, structured context, trace, and flag-gated callbacks.

## Direct invocation and observability

4. **Flows API (live docs)**
   https://docs.gitlab.com/api/duo_agent_platform_flows/
   Evidence sections: “Trigger a flow,” “Look up the consumer ID,” “Restart a flow,” “Get workflow trace as JSONL,” and “List all agent privileges.” Documents the POST route, every request field used in this report, `201` response, 19.5 GA history, experimental restart/trace, and privilege mapping.

5. **Webhook callbacks for flows**
   https://docs.gitlab.com/user/duo_agent_platform/flows/webhook_callbacks/
   Evidence: callbacks require a project/group webhook with Duo callbacks enabled; `callback_hook_id` and `client_reference` are passed on launch; terminal events can duplicate; terminal delivery retries up to five times; progress is not retried. Status is Experiment and not production-ready.

6. **Webhook event payloads — GitLab Duo flow events**
   https://docs.gitlab.com/user/project/integrations/webhook_events/#gitlab-duo-flow-events
   Evidence: exact event names and payload fields; completion/failure shapes; progress limits; out-of-order warning; workflow ID/status/UI URL; `X-Gitlab-Event: Duo Flow Callback`.

7. **Webhooks — signing tokens**
   https://docs.gitlab.com/user/project/integrations/webhooks/#signing-tokens
   Evidence: HMAC-SHA256 signing, Standard Webhooks headers, exact signed message, constant-time comparison, and replay-timestamp guidance.

8. **Sessions**
   https://docs.gitlab.com/user/duo_agent_platform/sessions/
   Evidence: sessions show flow execution data, UI cancellation, human checkpoints, and 30-day last-activity retention. No public REST cancellation route is given.

9. **GitLab 19.4 public implementation of flow creation**
   https://gitlab.com/gitlab-org/gitlab/-/blob/20b069154492c5f1dcab66552f4e88f30b844463/ee/lib/api/ai/duo_workflows/workflows.rb
   Evidence: authenticated POST route and validation; catalog-consumer branch; current source constructs catalog execution parameters without forwarding request privilege arrays. This is implementation evidence, not a guaranteed public contract.

10. **Current public implementation snapshot**
    Commit: `e2bf69b658008a5994323826457e77d67946a34d`
    https://gitlab.com/gitlab-org/gitlab/-/blob/e2bf69b658008a5994323826457e77d67946a34d/ee/lib/api/ai/duo_workflows/workflows.rb
    Evidence: confirms the catalog branch behavior and exposes internal routes not all present in public user API docs. Internal routes were deliberately excluded from the recommended contract.

## Custom flows, catalog, schema, and triggers

11. **Custom flows**
    https://docs.gitlab.com/user/duo_agent_platform/flows/custom/
    Evidence: create/enable/use flow, required roles, service account creation, Developer membership, GA history, and runtime OAuth-token header requirements.

12. **Custom flow YAML schema**
    https://docs.gitlab.com/user/duo_agent_platform/flows/custom_flows_schema/
    Evidence: Flow Registry v1 dependency, goal formats, `coding_environment`, and rejected fields.

13. **Flow Registry v1 specification — immutable snapshot**
    Commit: `c4590bb70473c80ee648a317166185a5e14c790e`
    https://gitlab.com/gitlab-org/modelops/applied-ml/code-suggestions/ai-assist/-/blob/c4590bb70473c80ee648a317166185a5e14c790e/docs/flow_registry/v1.md
    Evidence: required top-level structure, component types, prompts, toolsets/tool options, cycle limits, UI logs, and examples.

14. **Flow Registry framework overview — immutable snapshot**
    https://gitlab.com/gitlab-org/modelops/applied-ml/code-suggestions/ai-assist/-/blob/c4590bb70473c80ee648a317166185a5e14c790e/docs/flow_registry/index.md
    Evidence sections: input/output state, “Additional Context,” routers, and headless testing. Documents `flow.inputs`, matching categories, serialized-JSON `Content`, and `context:inputs.<category>`.

15. **AI Catalog**
    https://docs.gitlab.com/user/duo_agent_platform/ai_catalog/
    Evidence: definitions stored in catalog; managing project; CI/CD publication option; immutable versions/pinning; 40 KiB flow limit; public/restricted/private visibility.

16. **Triggers**
    https://docs.gitlab.com/user/duo_agent_platform/triggers/
    Evidence: complete event/action list and the explicit rule that non-human users (bots, service accounts, other flows) cannot activate any trigger.

17. **Agent tools**
    https://docs.gitlab.com/user/duo_agent_platform/agents/tools/
    Evidence: named GitLab tools, but page scope says custom agents. It is not by itself a complete custom-flow parameter contract.

18. **Public documentation gap issue for custom-flow tools**
    https://gitlab.com/gitlab-org/gitlab/-/work_items/599501
    Evidence: GitLab records missing complete tool/parameter documentation and the need to combine custom-flow docs with the Flow Registry specification. Used only to label the gap, not to assert product behavior.

## Identity, auth, governance, and availability

19. **Composite identity**
    https://docs.gitlab.com/user/duo_agent_platform/composite_identity/
    Evidence: user/service-account intersection, more restrictive role, shared project boundary, and runtime OAuth `ai_workflows`/`mcp` scopes.

20. **REST API authentication**
    https://docs.gitlab.com/api/rest/authentication/
    Evidence: OAuth/PAT/project/group token forms, token headers, scope failures, and job tokens only for supported endpoints.

21. **Fine-grained token REST permissions**
    https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/
    GraphQL permissions: https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_graphql/
    Source snapshot: https://gitlab.com/gitlab-org/gitlab/-/blob/e2bf69b658008a5994323826457e77d67946a34d/doc/auth/tokens/fine_grained_access_tokens_rest.md
    Evidence: Duo Workflow Create maps to `POST /ai/duo_workflows/workflows`; trace and privilege lookup map to REST Read; the GraphQL permission table covers workflow create/read/update/delete types and mutations.

22. **Agent Platform prerequisites/control**
    https://docs.gitlab.com/user/duo_agent_platform/
    https://docs.gitlab.com/user/duo_agent_platform/turn_on_off/
    Evidence: Duo/Agent Platform configuration, credits, offering-specific enablement, project/group prerequisites.

23. **Feature flag list**
    https://docs.gitlab.com/administration/feature_flags/list/
    Evidence on access date: `duo_flow_callback_hooks` and `enforce_composite_identity_for_api_started_workflows` are 19.4 flags disabled by default.

24. **Agent tool governance**
    https://docs.gitlab.com/user/ai-governance/tool-governance/
    Evidence: Allow/Ask/Deny modes, background access, default matrix, and background-flow enforcement feature flag.

## Runtime, network, secrets, models, and cost

25. **Configure flow execution**
    https://docs.gitlab.com/user/duo_agent_platform/flows/execution/
    Evidence: CI versus local execution, executor architecture, `.gitlab/duo/agent-config.yml`, setup-script risk, OIDC ID tokens, runner tag/scope/executor, and sandbox requirements.

26. **Flow execution variables**
    https://docs.gitlab.com/user/duo_agent_platform/flows/execution_variables/
    Evidence: allowed variables, unavailable custom CI/CD variables, composite job token, identity variables, and GitLab base URL handling.

27. **Configure images for flow execution**
    https://docs.gitlab.com/user/duo_agent_platform/flows/execution/images/
    Evidence: default UBI image, runtimes, custom/hardened image requirements, and security context.

28. **Security threats in agentic systems**
    https://docs.gitlab.com/user/duo_agent_platform/security_threats/
    Evidence: remote-flow sandbox/network model, composite identity, tool restrictions, and prompt-injection mitigations.

29. **MCP clients**
    https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_clients/
    Evidence: explicitly lists Agentic Chat and Software Development Flow as external MCP clients; does not establish arbitrary custom background flow support.

30. **GitLab MCP server and authentication**
    https://docs.gitlab.com/user/model_context_protocol/mcp_server/
    Evidence: GA offering, recommended HTTP endpoint `/api/v4/mcp`, OAuth `mcp` and fine-grained-PAT MCP Execute authentication, explicit rejection of legacy/project/group access tokens, DCR behavior, and rate-limit notes.

31. **GitLab MCP server tools**
    https://docs.gitlab.com/user/model_context_protocol/mcp_server_tools/
    Evidence sections: `list_duo_agents_and_flows`, `start_duo_session`, `list_duo_sessions`, `get_duo_session`, and `send_duo_session_input`. Documents custom consumer selection, async workflow ID, polling hints/status/final answer, created-resource lists, and 19.4/19.5 history.

32. **Agent Platform AI models**
    https://docs.gitlab.com/user/duo_agent_platform/model_selection/
    Evidence: current model table and group/instance selection behavior. Its updated default conflicts with stale model text on the general Flows page; this conflict is reported rather than resolved by assumption.

33. **GitLab Credits and usage billing**
    https://docs.gitlab.com/subscriptions/gitlab_credits/
    Evidence: model-call billing, flows making multiple calls, failure charging differences, and separate feature-specific flat pricing.

## Hackathon

34. **Life After Code official rules**
    https://gitlab-transcend.devpost.com/rules
    Evidence: official dates, eligibility, Path A/B requirements, public GitLab/MIT/pipeline/video requirements, IP terms, and judging criteria.

35. **Life After Code overview**
    https://gitlab-transcend.devpost.com/
    Evidence: required GitLab Duo Agent Platform use, autonomy categories, stages, submission checklist, and prize framing.

36. **Life After Code schedule**
    https://gitlab-transcend.devpost.com/details/dates
    Evidence: submission deadline 2026-10-27 13:00 UTC, judging window, and winner announcement date.

37. **GraphQL API reference — flow mutations and queries**
    API overview: https://docs.gitlab.com/api/graphql/
    Mutations: https://docs.gitlab.com/api/graphql/reference/experimental/mutations/
    Queries: https://docs.gitlab.com/api/graphql/reference/experimental/queries/
    Objects: https://docs.gitlab.com/api/graphql/reference/experimental/objects/
    Enums: https://docs.gitlab.com/api/graphql/reference/experimental/enums/
    Evidence: experimental `aiDuoWorkflowCreate`; owner-scoped `duoWorkflowWorkflows` status query; experimental `duoWorkflowEvents`; experimental flow-schedule create/update/delete mutations and schedule fields; experimental workflow deletion.

38. **Current GraphQL implementation snapshots**
    Workflow type: https://gitlab.com/gitlab-org/gitlab/-/blob/e2bf69b658008a5994323826457e77d67946a34d/ee/app/graphql/types/ai/duo_workflows/workflow_type.rb
    Create mutation: https://gitlab.com/gitlab-org/gitlab/-/blob/e2bf69b658008a5994323826457e77d67946a34d/ee/app/graphql/mutations/ai/duo_workflows/create.rb
    Workflow resolver: https://gitlab.com/gitlab-org/gitlab/-/blob/e2bf69b658008a5994323826457e77d67946a34d/ee/app/graphql/resolvers/ai/duo_workflows/workflows_resolver.rb
    Schedule mutation: https://gitlab.com/gitlab-org/gitlab/-/blob/e2bf69b658008a5994323826457e77d67946a34d/ee/app/graphql/mutations/ai/flow_schedules/create.rb
    Evidence: exact global-ID types, owner/permission boundary, selectable status/session fields, create-versus-start distinction, and schedule authorization/input mapping. Source evidence is used to interpret, not replace, the public schema contract.

## Search limits and negative findings

- The archived-docs host returned HTTP 403 from this environment. The immutable `19-4-stable-ee` source snapshot was used instead.
- GraphQL `aiDuoWorkflowCreate` is documented but creates a session record and has no documented background-start argument; it is not treated as a replacement for the REST custom-flow launch.
- No documented general workflow-status REST GET, REST cancellation route, REST artifact-list route, launch idempotency field, or arbitrary custom-flow-to-external-MCP guarantee was found. GraphQL status queries, experimental cron schedules, and GitLab 19.5 MCP status are separately documented in the report.
- No live account validation was attempted because the brief forbids external side effects and no authorized test namespace/credentials were provided.
