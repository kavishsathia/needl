import type { Provider } from "../../../src/core/types.js";
import type { ParamValues } from "../../../src/rules/compile.js";

/** Worked example rules: the starting points offered in the composer and the examples the authoring agent learns from. */
export interface ExampleRule {
  readonly id: "no-ghosts" | "boomerang" | "clean-break";
  readonly name: string;
  /** What a person would type for this rule. */
  readonly prompt: string;
  readonly providers: readonly Provider[];
  readonly source: string;
  readonly values: ParamValues;
}

export const exampleRules: readonly ExampleRule[] = [
  {
    id: "no-ghosts",
    name: "No ghosts",
    prompt: "Once a fix for an issue ships to production, errors tagged with that issue must not come back",
    providers: ["gitlab", "sentry"],
    values: {},
    source: `rule "Once a branch for an issue is successfully deployed to {environment}, no error or error alert tagged with that issue may appear in {environment} again"

input environment: text = "production"

always (
  gitlab.deployment(status = "success", environment = $environment) bind issue = ref.issue_key
  -> never (
    sentry.event_alert(tags.linear_issue.issue_key = issue, environment = $environment)
    or sentry.error(tags.linear_issue.issue_key = issue, environment = $environment)
  )
)`,
  },
  {
    id: "boomerang",
    name: "Boomerang",
    prompt: "Once a Sentry issue is resolved, it must never come back",
    providers: ["sentry"],
    values: {},
    source: `rule "Once a Sentry issue is resolved, it must never be unresolved again"

always (
  sentry.issue(action = "resolved") bind issue = issue
  -> never sentry.issue(action = "unresolved", issue = issue)
)`,
  },
  {
    id: "clean-break",
    name: "Clean break",
    prompt: "Once a customer cancels their subscription, they must never be charged again",
    providers: ["stripe"],
    values: {},
    source: `rule "Once a customer cancels their subscription, they must never be charged again by a paid invoice, a successful charge or a successful payment"

always (
  stripe.customer.subscription.deleted bind customer = customer
  -> never (
    stripe.invoice.paid(customer = customer)
    or stripe.charge.succeeded(customer = customer)
    or stripe.payment_intent.succeeded(customer = customer)
  )
)`,
  },
];
