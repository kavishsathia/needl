import type { Provider } from "../core/types.js";
import { catalogue, type CatalogueField } from "./catalogue.js";

/** Reference for people and for the authoring agent; kept next to the parser so the two cannot drift apart. */
export const ruleLanguageGuide = `NEEDL RULE LANGUAGE

A rule watches the native webhook events of each integration and states something that must never be broken.
Every rule starts with \`always (…)\` or \`never …\`: a rule is checked from the first event Needl receives, so
without one of these it would only look at that first event.

EVENTS
  provider.event                      e.g. gitlab.deployment, stripe.invoice.paid, sentry.issue
  provider.event(field op value, …)   conditions that must all hold, e.g. gitlab.deployment(status = "success")
  ops: = != < <= > >= contains starts_with in        in takes a list ["a", "b"] or a $choice
  values: "text", 42, true/false, $choice, or a bound name

COMBINING (loosest to tightest)
  A -> B                if A happens at this event, B must hold from this event on (right-associative)
  A or B, A and B
  A until B             A holds at every event until B happens, and B MUST happen (not allowed without a time limit)
  A until within 30m B  …and B happens within 30 minutes
  A unless B            A holds at every event until B happens; B never has to happen
  not A, never A        never A = at no event from here on
  always A              at every event from here on
  always within 1h A    at every event for the next hour
  eventually within 2h A   A happens within 2 hours (eventually without a time limit is not allowed)
  next A                at the very next event Needl receives from any integration (rarely what people mean;
                        for "soon after" use eventually within)
  ( … )                 grouping
  Durations: 30s, 15m, 2h, 1d. Time limits start at the event where that part is first evaluated; if no event
  arrives, a clock tick still catches the expired limit.

BOUND VALUES (captured from one event, used later)
  event(…) bind name = field -> …      only directly on the left of ->; the value is taken from that event and is
                                       usable on the right side, e.g.
                                       stripe.customer.subscription.deleted bind customer = customer
                                         -> never stripe.invoice.paid(customer = customer)
  bind name = provider.event.field in …   the general form, anywhere
  Compare later events against it with field = name. Bound values compare as text.
  A rule shaped "always (… bind x = … -> …)" in which every other event compares a field with x is monitored separately
  for each value of x (each issue, each customer), so one violation never stops monitoring the others.

CHOICES ($name)
  $environment is a value the user picks when the rule is set up and can change later; it renders as a dropdown.
  Its type and suggested values come from the fields it is compared with. Use the same $name everywhere the same
  choice applies (e.g. the deploy environment and the error environment). Use \`field in $name\` for several values.
  Use a $choice for anything the user might reasonably want to change (environments, projects, teams, amounts);
  use a literal for what defines the rule itself (e.g. status = "success" for a successful deploy).

NOTES (#"…" before any part)
  A note is the English reading of the part right after it. {1}, {2}, … stand for that part's own parts, in the
  order they appear in the source: for an event, each condition's value then each bind; for always/eventually/
  until with a time limit, the duration is a part; for A -> B, A is {1} and B is {2}; for A and B / A or B, each
  operand. Every part must be used exactly once. Notes must not contain numbers, values, or provider.event names:
  values and time limits always come from slots, so the reading can never show something the rule does not check.
  A part without a note is read mechanically. Put a note on the parts a person reads; keep notes short and plain.
  To annotate a whole -> / and / or, wrap it in parentheses: #"once {1}, {2}" ( A -> B ).
  Count parts carefully: in  #"…" never ( A or B )  the never has ONE part, {1} = (A or B); to word A and B
  separately, put a note on each of them instead. An event with no conditions and no bind has no parts, so its
  note has no slots.

SAFETY (enforced by the checker)
  Needl only runs rules that a single observed event or a passed time limit can break. Unbounded eventually,
  until without a time limit, not always, not never and not … unless … are rejected. Give a time limit instead.

COMMENTS
  // to the end of the line`;

function fieldLine(field: CatalogueField): string {
  const values = field.values.kind === "fixed"
    ? ` one of ${field.values.options.map((option) => JSON.stringify(option.value)).join(", ")}`
    : field.values.kind === "identifier" ? " (an id; compare with a bound value)" : "";
  const shape = field.literal === undefined ? "" : ` Literals must be ${field.literal.description}.`;
  return `    ${field.name}: ${field.type}${values}. ${field.description}${shape}`;
}

/** Text listing of every integration's events and fields, optionally marking which integrations are connected. */
export function describeCatalogue(connected?: ReadonlySet<Provider>): string {
  return catalogue.map((entry) => {
    const status = connected === undefined ? "" : connected.has(entry.provider) ? " [connected]" : " [not connected]";
    const events = entry.events.map((event) => {
      const families = (event.families ?? []).map((family) => `    ${family.prefix}.<key>: string. ${family.description}${(family.derived ?? []).map((derived) => `\n    ${family.prefix}.<key>.${derived.suffix}: string. ${derived.description}`).join("")}`);
      return [`  ${entry.provider}.${event.name} — ${event.description}`, ...event.fields.map(fieldLine), ...families].join("\n");
    });
    return [`${entry.label} (${entry.provider})${status}: ${entry.description}`, ...events].join("\n");
  }).join("\n\n");
}

