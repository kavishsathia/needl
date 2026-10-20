# Business invariants needl can watch today

Every rule below uses only events and fields in needl's current catalogue (`src/rules/catalogue.ts`) and passes `checkRule`. Paste a rule into needl's composer to monitor it; inputs such as environments and time limits can be changed there.

Rules that join two tools rely on a shared value: GitLab branch names, Sentry tags and Linear keys all carry the issue key (for example `ENG-42`).

## Engineering

GitLab, Sentry, Linear and LaunchDarkly together: what shipping is supposed to guarantee.

### When a pipeline on <branch> fails, a passing pipeline on <branch> must follow within <time_limit>

A red main branch blocks everyone. Pairs with GitLab's built-in Fix CI/CD Pipeline flow.

```text
rule "When a pipeline on {branch} fails, a passing pipeline on {branch} must follow within {time_limit}"
input branch: text = "main"
input time_limit: duration = 1h
always (
  gitlab.pipeline(status = "failed", ref = $branch)
  -> eventually within $time_limit gitlab.pipeline(status = "success", ref = $branch)
)
```

### Once a branch for an issue is successfully deployed to <environment>, that Linear issue must be completed within <time_limit>

Shipped work left open in Linear makes the board lie about what is done.

```text
rule "Once a branch for an issue is successfully deployed to {environment}, that Linear issue must be completed within {time_limit}"
input environment: text = "production"
input time_limit: duration = 1d
always (
  gitlab.deployment(status = "success", environment = $environment) bind key = ref.issue_key
  -> eventually within $time_limit linear.issue(identifier = key, state_type = "completed")
)
```

### Once a fix for an issue is deployed to <environment>, errors tagged with that issue must never appear there again

A fix that shipped but did not work: the same issue's errors return after the deploy.

```text
rule "Once a fix for an issue is deployed to {environment}, errors tagged with that issue must never appear there again"
input environment: text = "production"
always (
  gitlab.deployment(status = "success", environment = $environment) bind key = ref.issue_key
  -> never sentry.error(tags.linear_issue.issue_key = key, environment = $environment)
)
```

### For <time_limit> after a flag is turned on in <environment>, no critical metric alert may fire

Ties a flag rollout to the incident it causes, so the flag can be turned off fast.

```text
rule "For {time_limit} after a flag is turned on in {environment}, no critical metric alert may fire"
input environment: text = "production"
input time_limit: duration = 30m
always (
  launchdarkly.flag(actions contains "updateOn", environment = $environment)
  -> always within $time_limit not sentry.metric_alert(action = "critical")
)
```

### A critical metric alert must be resolved within <time_limit>

A critical alert left firing is an outage nobody is working on.

```text
rule "A critical metric alert must be resolved within {time_limit}"
input time_limit: duration = 1h
always (
  sentry.metric_alert(action = "critical") bind rule_id = alert_rule
  -> eventually within $time_limit sentry.metric_alert(action = "resolved", alert_rule = rule_id)
)
```

### Every new fatal Sentry issue must be assigned within <time_limit>

Fatal errors with no owner are the ones that sit for days.

```text
rule "Every new fatal Sentry issue must be assigned within {time_limit}"
input time_limit: duration = 30m
always (
  sentry.issue(action = "created", level = "fatal") bind id = issue
  -> eventually within $time_limit sentry.issue(action = "assigned", issue = id)
)
```

## Billing

Stripe: money moving the way the business promised.

### Once an invoice is paid, no payment attempt on it may fail afterwards

A paid invoice being charged again, and failing, means billing is retrying money it already has.

```text
rule "Once an invoice is paid, no payment attempt on it may fail afterwards"
always (
  stripe.invoice_payment.paid bind inv = invoice
  -> next never stripe.invoice.payment_failed(id = inv)
)
```

### An invoice must never be paid by a second payment

Retries or race conditions charging the same invoice twice.

```text
rule "An invoice must never be paid by a second payment"
always (
  stripe.invoice_payment.paid bind inv = invoice
  -> next never stripe.invoice_payment.paid(invoice = inv)
)
```

### After an invoice payment fails, the customer must pay or lose access within <time_limit>

Failed payments that never resolve leave customers on a paid plan for free.

```text
rule "After an invoice payment fails, the customer must pay or lose access within {time_limit}"
input time_limit: duration = 7d
always (
  stripe.invoice.payment_failed bind cust = customer
  -> eventually within $time_limit (
    stripe.invoice.paid(customer = cust)
    or stripe.customer.subscription.updated(customer = cust, status in ["past_due", "unpaid", "canceled", "paused"])
    or stripe.customer.subscription.deleted(customer = cust)
  )
)
```

### Once a payment is disputed, it must never be charged again

Charging a disputed payment again invites a second chargeback.

```text
rule "Once a payment is disputed, it must never be charged again"
always (
  stripe.charge.dispute.created bind pi = payment_intent
  -> next never stripe.charge.succeeded(payment_intent = pi)
)
```

### Production must never record a successful test-mode charge

Test-mode traffic reaching the production webhook means keys or endpoints are mixed up.

```text
rule "Production must never record a successful test-mode charge"
never stripe.charge.succeeded(livemode = false)
```

## Support and delivery

Linear and Intercom: promises made to customers.

### An urgent Linear issue must be started within <time_limit> of being created

Urgent work that nobody starts is a broken on-call promise.

```text
rule "An urgent Linear issue must be started within {time_limit} of being created"
input time_limit: duration = 1h
always (
  linear.issue(action = "create", priority = 1) bind key = identifier
  -> eventually within $time_limit linear.issue(identifier = key, state_type in ["started", "completed"])
)
```

### No Linear issue SLA may ever be breached

Every breach is a promise to a customer that was not kept.

```text
rule "No Linear issue SLA may ever be breached"
never linear.issue_sla(action = "breached")
```

### Every conversation a customer starts must get a teammate reply within <time_limit>

A first-response promise to customers.

```text
rule "Every conversation a customer starts must get a teammate reply within {time_limit}"
input time_limit: duration = 1h
always (
  intercom.conversation.user.created bind convo = id
  -> eventually within $time_limit intercom.conversation.admin.replied(id = convo)
)
```

### A customer conversation must never be closed before a teammate has replied

Closing a conversation nobody answered hides it from support metrics.

```text
rule "A customer conversation must never be closed before a teammate has replied"
always (
  intercom.conversation.user.created bind convo = id
  -> not intercom.conversation.admin.closed(id = convo) unless intercom.conversation.admin.replied(id = convo)
)
```

## Privacy

PostHog: what deleting an account has to mean.

### Once a person deletes their account, no further analytics events may arrive for them

Tracking someone after they deleted their account is a privacy and compliance failure.

```text
rule "Once a person deletes their account, no further analytics events may arrive for them"
always (
  posthog.event(event = "account_deleted") bind person = distinct_id
  -> next never posthog.event(distinct_id = person)
)
```
