# Needl safety-only, meaning-first product UX

User explicitly approved implementation ('try it') of the following revised presentation. This overrides prior frontend decisions exposing formulas as the primary UX or including liveness/deadline templates. Read FRONTEND-BRIEF.md, FRONTEND-REPAIR.md, current handoff and actual source first. Preserve all repair regressions. Work only after the preceding repair worker has finished. Frequent focused commits using configured identity. No deployment or pushing.

## Product decision
Research and product are different: the formal engine stays underneath; real users should not have to read mathematical notation or raw code. Only safety properties in the product for this version. No unbounded eventuality or deadline-response assertions offered/enabled in product authoring. Keep the existing library's general LTL/deadline capabilities and tests intact for backward compatibility; constrain the product layer, not remove engine functionality.

## Presentation
Keep the approved dark, warm, zoomed-out masonry board. Each card reads like a normal sentence with subtle editable inline chips, not a formula block or label-heavy form. Examples:
- Fixed means fixed: After [a fix is deployed], [the linked issue] must not [occur again] in [Production].
- Off means off: While [checkout-v2] is [disabled], [errors from checkout-v2] must not occur.
Use genuine data-backed editable pieces. Clicking a chip opens a focused accessible selector/popover. Changes must update canonical structured assertion meaning and version, not only visible copy. Only offer values supported by demo evidence or explicitly show no matching evidence. Avoid cosmetic chips that don't change the monitor. Avoid general NL translation claims; retain an honestly labeled template-assisted interpretation seam until LLM wiring exists.

Composer: 'What should never happen?' Suggestions can include cancelled subscriptions charged again, orders fulfilled before payment, support promising fixed before deployment, disabled feature errors. Implement a small coherent set fully wired to actual runtime fixture scenarios; don't create decorative unsupported examples as active monitors. At minimum retain recurrence/disabled-feature and replace the provisioning deadline example with a substantive safety scenario, such as order fulfilled before payment, using explicit correlated observations and actual state. Do not claim missing prior payment proves nonpayment unless scenario includes a defined observed lifecycle/initial-state boundary; make the demo semantics explicit.

Primary controls never require formula or JSON editing. Expert inspection may exist under a collapsed secondary Advanced specification affordance, but enabling/editing must pass the same safety validation. Do not render raw parser errors to normal users.

When a user supplies an eventuality like 'Every paid order should eventually be fulfilled', show friendly unsupported feedback: 'This describes something that should eventually happen. Needl needs a condition it can catch being broken.' Offer user-confirmed alternatives; never silently rewrite intent. Reject eventual/deadline constructs from expert edits, restored data and API entrypoints as well; document the supported safety syntax and its conservative validation strategy. No keyword-only safety checker: verify structured semantics. A limited sound recognized subset is preferable to pretending to decide every formula's safety. Reject unsupported shapes with explanation. Preserve existing unsupported saved rules as disabled/needs-review rather than silently deleting a user's collection. User-owned text and historical evidence should survive migration.

## Expanded detail / evidence
Lead with a concrete business explanation, e.g. 'Checkout-v2 produced an error while disabled.' Show timeline source + time + event, with genuine engine-backed evidence. Link phrase/chip selection to corresponding trace entries, and clicking evidence should highlight its role in the readable rule. Derive this mapping explicitly from the supported template/predicate model; don't invent causal attribution for arbitrary events. Keyboard accessible, reduced motion, Firefox-compatible view-transition fallback.

Monitoring label: 'Watching · No violations observed', not 'safe' or universally 'satisfied'. The breach view should distinguish requested/pending/simulated investigations from real started agents. No mock live connections.

## Tests and acceptance
RED/GREEN tests for safety-only enforcement at UI/server/restore/advanced-editor boundaries; migration retaining unsupported rules disabled and preserving user text; actual chip edits change formula/predicates/scope and discriminating engine output; safety demo violations and healthy controls; phrase-to-trace highlighting via keyboard and mouse; plain-language authoring without needing formula editor; unsupported eventuality explanation; all previous replay-race/validation/capacity/navigation regressions.

Retain library tests and revised baseline frontend regressions rather than deleting tests to make the safety-only version pass. Deadline functionality can still be tested at library/internal layer; product rejection must be a separate gate. Test collection validation also for paused/needs-review records so unsupported inputs cannot bypass policy on enable.

Run full typecheck/unit/build/fresh Playwright journeys. Capture desktop board, expanded evidence and mobile screenshots and inspect them. Update PRD product scope and FRONTEND-HANDOFF.md (preserve distinction between library capability and safety-only product). Write SAFETY-UX-HANDOFF.md with exact commands/results and screenshot paths. Final clean working tree; no core TODOs, no paid API calls or external mutations.
