# Needl — Product Requirements Document

Status: product direction / initial build
Owner and concept author: Kavish
Domain: needl.dev

## 1. Product thesis

Agents generate more code than people can maintain a detailed mental model of. People still know how their business should behave. Needl lets them express those expectations as assertions, observe the running business across services, and activate an agent when reality contradicts an expectation.

**Agents write the code. You define what must hold. When reality breaks that expectation, an agent responds.**

Needl is an operational feedback loop around business expectations. The central object is an assertion with its structured meaning, observation history, counterexamples, and responses—not a chatbot or a raw-log dashboard.

## 2. Target users and job

Builders and small engineering teams shipping agent-generated software and operating across development, monitoring, support, billing, and feature-management systems.

Job: express what should remain true without inspecting every implementation detail; see evidence when expectations fail; initiate a contextual investigation and follow its outcome.

## 3. Core user journey

1. Connect relevant services.
2. Type a business assertion in natural language.
3. Inspect the structured interpretation produced by an LLM and select scope/response.
4. Enable monitoring.
5. See the assertion as a persistent card on a board.
6. When a violation occurs, open the counterexample and its source events.
7. Follow the GitLab agent flow's investigation, proposed action, and outcome.
8. Continue monitoring after remediation.

## 4. Interface direction

Google Keep-inspired interface: a natural-language input box above a collage of assertion cards. Cards show the structured interpretation, connected services, monitoring status, and violation count. Exact LTL is available for inspection, not required as the primary authoring experience.

Clicking a card uses view transitions to morph that card into its detail view. Preserve its visual identity through the transition. The detail view contains:

- Editable expectation and structured specification.
- Counterexamples for all recorded violations, with event timelines and links to original evidence.
- Side-panel analytics: violation frequency, last occurrence, investigation status, and response timing.
- Agent investigation history, external artifacts, and approval requests.

No Scratch-style canvas or agent organization dashboard in the initial product.

## 5. Assertion authoring and monitoring

An LLM translates natural-language intent into a typed structured LTL representation using connected providers' schemas. The user sees the interpreted rule before enabling it. Store the original text, structured representation, scope, and version together.

The runtime monitor consumes normalized events deterministically; an LLM is not required for every event. Bind observations to specific entities such as an issue, service, release, customer, or subscription. Record sufficient provenance to reconstruct why a rule was violated.

Support an explicit initial monitorable subset. Safety violations such as recurrence after a fix can be demonstrated by finite evidence. Deadline-based expectations require explicit time bounds and timer events; unbounded eventualities remain pending while evidence is incomplete. Unsupported expressions should be identified during authoring rather than silently approximated.

Distinguish monitoring, pending obligation, violated, paused, and unavailable/stale observation states. A quiet source is not automatically evidence that a business expectation is satisfied.

## 6. Integration scope

All connectors are modular webhook-driven units reusable by the backend. GitLab is the engineering and agent execution platform. **No GitHub integration or GitHub-centered demo.**

| Provider | Observations / role |
| --- | --- |
| GitLab | Merge requests, pipelines, deployments; investigation and response through GitLab agent flows |
| Linear | Issue state, completion commitments, and follow-up work |
| LaunchDarkly | Feature-flag changes and configuration state |
| Sentry | Errors, issue lifecycle, recurrence evidence, affected environments/releases |
| PostHog | Product events and customer journey evidence |
| Intercom | Customer conversations, support commitments, and tickets |
| Stripe | Payment, refund, and subscription events |

Actual webhook coverage is provider-specific and documented by each adapter. Normalize event identity, delivery identity where available, tenant, source, occurrence/receipt times, entities, relationships, and evidence links. Preserve the original payload under controlled access. Do not infer a causal relationship solely from coincident timestamps.

Correlate explicit issue references, commit/release identifiers, service/environment keys, customer IDs, and configured mappings. Webhooks ingest observations; privileged external actions belong to separately authorized agent tools.

## 7. Representative assertions

These are candidate product scenarios, not a promise that all are in the first demo:

- Once a Linear bug is marked Done and its linked fix is deployed, the corresponding Sentry issue should not recur in that environment.
- While a feature is disabled in LaunchDarkly, errors attributed to executing that feature should not occur.
- After signup completes, workspace creation should follow within a chosen deadline, observed through PostHog events.
- A customer charged despite failed provisioning should receive a support ticket within ten minutes.
- When support tells a customer an issue is fixed, the linked fix should already be deployed to that customer's environment.

Statements derived from free-text support messages need an explicit interpretation step; provider webhooks do not themselves assert the semantic meaning of a promise.

## 8. Counterexample-driven response

A violation creates a durable record containing:

- Assertion identity, version, and readable expectation.
- Relevant observed event sequence and bindings.
- Explanation of the violated condition.
- Source links and associated business/development entities.
- Investigation identifier and lifecycle.

The record launches a GitLab agent flow. The agent can fetch additional context and investigate, propose a fix, open a merge request, or request approval. Choose permissions and approval boundaries per response policy. The monitor identifies the broken expectation; the agent reasons about cause and response.

Deduplicate launches for the same violation and retain retries. Record actual completion separately from requested actions. Agent completion does not erase the counterexample or prove the underlying issue resolved; monitoring continues.

## 9. Architecture

Webhook providers → authenticated adapters → durable normalized event log → entity correlation → assertion monitors → counterexample records → GitLab agent flows.

The assertion board reads assertion state, violations, and investigation progress from the backend. Authoring uses a separate LLM translation/validation path. Provider integrations remain independently importable and testable without the frontend, translator, or monitor.

## 10. Current implementation assignment

Codex is building only the reusable TypeScript integration package in this repository: all seven providers, raw-body verification, payload validation, normalization, backend receiver abstractions, persistence/replay example, tests, and documentation. Frequent focused commits are required.

Frontend, natural-language authoring, LTL monitoring, full entity correlation, and live GitLab agent orchestration are subsequent phases, not implied to exist because integrations have been implemented.

## 11. First complete demonstration

Show a Linear ticket marked fixed, the corresponding GitLab deployment, a LaunchDarkly flag change where relevant, and a subsequent Sentry recurrence. Needl displays the violated assertion and event evidence, then starts a GitLab investigation whose progress is visible on the card.

Acceptance:

1. A user authors an assertion and can inspect its structured interpretation.
2. Authenticated observations are stored and associated with the correct entities.
3. A discriminating violating sequence produces a counterexample; a nonviolating sequence does not.
4. Repeated delivery of the same event does not duplicate the incident or flow launch.
5. The card transitions into an evidence-backed violation view.
6. A real GitLab investigation is linked to that violation and its lifecycle is reflected in the UI.
7. Replay recovers the relevant monitor/incident state with explicit rule versions.

## 12. Verification and success measures

Test adapters with documented, clearly labeled synthetic fixtures and genuine signature algorithms. Exercise actual receiver/persistence/restart behavior locally. Live credential-dependent checks are reported separately from local tests.

Measure assertion compilation validity, correct detection on labeled event sequences, false activations, detection/response delay, trace completeness, duplicate suppression, and investigation outcomes. Analytics must distinguish 'no observed violation' from missing data.

## 13. Non-goals and execution boundaries

- Not a coding assistant replacement or general-purpose log dashboard.
- Not a claim that generated code is formally proved correct.
- Not a visual block-programming environment.
- No autonomous financial actions or production mutations without an explicit response policy and authorization.
- Repository development does not authorize deployment, external account provisioning, or paid cloud resources.

## 14. Hackathon alignment

GitLab Life After Code: agentic work after code generation—monitoring, investigation, testing, and remediation. GitLab Duo Agent Platform should be central to the operational response, not a decorative destination for alerts. Preserve development provenance and verify the chosen entry path's licensing/submission requirements before submission.
