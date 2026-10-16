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
    values: { environment: "production" },
    source: `always (
  #"once {1}, {2}"
  (
    #"a branch for an issue gets a {1} deploy to {2}, keeping {3}"
    gitlab.deployment(status = "success", environment = $environment) bind issue = ref.issue_key
    ->
    #"{1} must never appear there again"
    never (
      #"an error alert tagged {1} in {2}"
      sentry.event_alert(tags.linear_issue.issue_key = issue, environment = $environment)
      or
      #"an error tagged {1} in {2}"
      sentry.error(tags.linear_issue.issue_key = issue, environment = $environment)
    )
  )
)`,
  },
  {
    id: "boomerang",
    name: "Boomerang",
    prompt: "Once a Sentry issue is resolved, it must never come back",
    providers: ["sentry"],
    values: {},
    source: `always (
  #"once {1}, {2}"
  (
    #"a Sentry issue is {1}, keeping {2}"
    sentry.issue(action = "resolved") bind issue = issue
    ->
    #"{1} must never happen"
    never #"{2} being {1} again" sentry.issue(action = "unresolved", issue = issue)
  )
)`,
  },
  {
    id: "clean-break",
    name: "Clean break",
    prompt: "Once a customer cancels their subscription, they must never be charged again",
    providers: ["stripe"],
    values: {},
    source: `always (
  #"once {1}, {2}"
  (
    #"a customer cancels their subscription, keeping {1}"
    stripe.customer.subscription.deleted bind customer = customer
    ->
    #"they must never be charged again by {1}"
    never (
      #"a paid invoice for {1}" stripe.invoice.paid(customer = customer)
      or #"a successful charge for {1}" stripe.charge.succeeded(customer = customer)
      or #"a successful payment for {1}" stripe.payment_intent.succeeded(customer = customer)
    )
  )
)`,
  },
];
