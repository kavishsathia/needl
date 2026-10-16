import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const screenshotDir = new URL("../artifacts/screenshots/", import.meta.url);
mkdirSync(screenshotDir, { recursive: true });

function watchConsole(page: Page): string[] {
  const failures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  page.on("pageerror", (error) => failures.push(error.message));
  return failures;
}

let currentUser: { email: string; password: string };

test.beforeEach(async ({ page }, testInfo) => {
  await page.goto("/api/health");
  await page.evaluate(() => localStorage.clear());
  const suffix = createHash("sha256").update(`${testInfo.title}-${testInfo.retry}`).digest("hex").slice(0, 12);
  currentUser = { email: `e2e-${suffix}@needl.test`, password: "correct-horse-battery-staple" };
  const response = await page.request.post("/api/auth/sign-up/email", {
    headers: { origin: "http://127.0.0.1:4173" },
    data: { name: "Needl E2E", ...currentUser },
  });
  expect(response.status()).toBe(200);
});

/** A minimal valid engine-level assertion, for storage and API probes that do not need a rule. */
function plainDefinition(id: string, name: string) {
  return {
    id, version: 1, tenantId: "synthetic-demo", name,
    formula: { kind: "always", operand: { kind: "not", operand: { kind: "atom", name: "error" } } },
    scope: { keys: [{ name: "service", extractors: [{ from: "relationship", type: "service" }] }] },
    propositions: [
      { name: "error", predicate: { op: "equal", path: { root: "event", segments: ["kind"] }, value: "error.recurred" } },
      { name: "recovered", predicate: { op: "equal", path: { root: "event", segments: ["kind"] }, value: "error.recovered" } },
    ],
  };
}

async function authorFromExample(page: Page, expectation: string, example: RegExp): Promise<void> {
  await page.getByLabel("What should never happen?").fill(expectation);
  await page.getByLabel("Continue authoring").click();
  const dialog = page.getByRole("dialog", { name: "Review the rule" });
  await dialog.getByRole("button", { name: example }).click();
  await dialog.getByRole("button", { name: "Create paused rule" }).click();
}

function tenantStorage() {
  const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("needl.assertions.v1.ten_"));
  return JSON.parse(key === undefined ? "{}" : localStorage.getItem(key) ?? "{}");
}

test("browser signup, signout, and signin keep the private workspace", async ({ page }) => {
  await page.goto("/#/settings");
  await expect(page.getByText(`Signed in as ${currentUser.email}.`)).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

  const secondEmail = `second-${currentUser.email}`;
  await page.getByRole("button", { name: /Create an account/ }).click();
  await page.getByLabel("Name").fill("Second Needl User");
  await page.getByLabel("Email").fill(secondEmail);
  await page.getByLabel("Password").fill(currentUser.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Assertions", exact: true })).toBeVisible();
  await page.getByLabel("Open local settings").click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Email").fill(secondEmail);
  await page.getByLabel("Password").fill(currentUser.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Assertions", exact: true })).toBeVisible();
});

test("complete assertion journey uses engine evidence and persists authored state", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.goto("/#/assertions");
  await expect(page.getByRole("heading", { name: "Assertions", exact: true })).toBeVisible();
  await expect(page.getByText("Sample replay")).toBeVisible();
  await expect(page.locator(".assertion-card")).toHaveCount(3);

  await page.screenshot({ path: fileURLToPath(new URL("safety-desktop-board.png", screenshotDir)), fullPage: true });

  await page.getByLabel("What should never happen?").fill("Every checkout fix stays fixed after deployment");
  await page.getByLabel("Continue authoring").click();
  const dialog = page.getByRole("dialog", { name: "Review the rule" });
  await expect(dialog.getByText("AI authoring is not configured")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create paused rule" })).toBeDisabled();
  await dialog.getByRole("button", { name: /No ghosts/ }).click();
  await expect(dialog.getByTestId("rule-preview")).toContainText("must never appear there again");
  await dialog.getByRole("button", { name: "Create paused rule" }).click();

  const detail = page.locator(".detail");
  await expect(detail.getByRole("heading", { name: "Every checkout fix stays fixed after deployment", exact: true })).toBeVisible();
  await expect(detail.getByText("Paused", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "Enable" }).click();
  await expect(detail.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(detail.getByText("Needs attention", { exact: true })).toBeVisible();
  await page.waitForTimeout(2800);

  await detail.getByRole("button", { name: "Edit rule" }).click();
  await page.getByLabel("Name", { exact: true }).fill("A checkout fix must stay fixed after deployment");
  await page.getByRole("button", { name: /Check & save v2/ }).click();
  await expect(detail.getByRole("heading", { name: "A checkout fix must stay fixed after deployment", exact: true })).toBeVisible();
  await expect(page.getByText("Assertion · v2")).toBeVisible();

  await page.reload();
  await expect(detail.getByRole("heading", { name: "A checkout fix must stay fixed after deployment", exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Pause" })).toBeVisible();

  await page.getByRole("button", { name: /Counterexamples/ }).click();
  const counterexample = detail.locator(".counterexample");
  await expect(counterexample.getByRole("heading", { name: "A checkout fix must stay fixed after deployment was broken" })).toBeVisible();
  await expect(counterexample.getByText(/progressed LTL formula became false/)).toBeHidden();
  await expect(counterexample.getByText(/formula false/i)).toBeHidden();
  await expect(page.locator(".trace-timeline li")).toHaveCount(2);
  await expect(page.getByText("sentry", { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: fileURLToPath(new URL("safety-desktop-evidence.png", screenshotDir)), fullPage: true });

  await page.getByRole("button", { name: "Back to assertion board" }).click();
  await expect(page.getByRole("heading", { name: "Assertions", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open A checkout fix must stay fixed after deployment" })).toBeFocused();

  await page.getByRole("tab", { name: "Needs attention" }).click();
  await expect(page.locator(".assertion-card")).toHaveCount(4);
  await page.getByPlaceholder("Search Acme / Production").fill("Boomerang");
  await expect(page.locator(".assertion-card")).toHaveCount(1);
  await page.getByPlaceholder("Search Acme / Production").fill("");

  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.locator(".page-summary > div").filter({ hasText: "Counterexamples" }).getByText("4", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Connections" }).click();
  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
  await expect(page.getByText("Demo sources are not live connections")).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("rules started from each example read back in English and produce counterexamples", async ({ page }) => {
  const cases = [
    {
      expectation: "A renamed checkout repair never regresses",
      example: /No ghosts/,
      reading: "Once a branch for an issue gets a successful deploy to production, keeping its issue key in its branch as “issue”, an error alert tagged that issue in production, or an error tagged that issue in production must never appear there again.",
      choice: "environment: production",
    },
    {
      expectation: "A renamed resolved issue stays resolved",
      example: /Boomerang/,
      reading: "Once a Sentry issue is resolved, keeping its issue as “issue”, that issue being unresolved again must never happen.",
    },
    {
      expectation: "A renamed canceled customer stays uncharged",
      example: /Clean break/,
      reading: "Once a customer cancels their subscription, keeping its customer as “customer”, they must never be charged again by a paid invoice for that customer, a successful charge for that customer, or a successful payment for that customer.",
    },
  ] as const;

  await page.goto("/#/assertions");
  for (const item of cases) {
    await authorFromExample(page, item.expectation, item.example);
    const detail = page.getByRole("complementary", { name: `${item.expectation} detail` });
    await detail.getByRole("button", { name: "Enable" }).click();
    await expect(detail.getByText("Needs attention", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: /Counterexamples/ }).click();
    const counterexample = detail.locator(".counterexample");
    await expect(counterexample.getByRole("heading", { name: `${item.expectation} was broken` })).toBeVisible();
    await expect(counterexample.getByText(/progressed LTL formula became false/)).toBeHidden();
    await page.getByRole("button", { name: "Back to assertion board" }).click();

    const card = page.getByTestId(`assertion-card-local-${item.expectation.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36)}`);
    await expect(card.locator(".meaning-sentence")).toHaveText(item.reading);
    if ("choice" in item) await expect(card.getByRole("button", { name: item.choice }).first()).toBeVisible();
  }
});

test("replay switches between violating and healthy engine paths", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.goto("/#/assertions");
  await expect(page.locator(".assertion-card--violated")).toHaveCount(3);
  await page.getByRole("button", { name: /Replay healthy path/ }).click();
  await expect(page.locator(".assertion-card--violated")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Replay violations/ })).toBeVisible();
  await page.getByRole("button", { name: /Replay violations/ }).click();
  await expect(page.locator(".assertion-card--violated")).toHaveCount(3);
  expect(consoleErrors).toEqual([]);
});

test("hand-written rules are checked live: liveness is refused with its location and a time limit is accepted", async ({ page }) => {
  await page.goto("/#/assertions");
  await page.getByLabel("What should never happen?").fill("A failed invoice payment must be recovered");
  await page.getByLabel("Continue authoring").click();
  const dialog = page.getByRole("dialog", { name: "Review the rule" });
  await dialog.getByText("Rule", { exact: true }).click();
  const source = dialog.getByLabel("Rule source");
  await source.fill("always (stripe.invoice.payment_failed bind customer = customer -> eventually stripe.invoice.paid(customer = customer))");
  await expect(dialog.locator(".rule-errors")).toContainText("1:67");
  await expect(dialog.locator(".rule-errors")).toContainText("`eventually` has no time limit");
  await expect(dialog.getByRole("button", { name: "Create paused rule" })).toBeDisabled();

  await source.fill("always (stripe.invoice.payment_failed bind customer = customer -> eventually within 1h stripe.invoice.paid(customer = customer))");
  await expect(dialog.locator(".rule-errors")).toHaveCount(0);
  await expect(dialog.getByTestId("rule-preview")).toContainText("within 1 hour, there must be a paid Stripe invoice where customer is that customer");
  await dialog.getByRole("button", { name: "Create paused rule" }).click();

  const detail = page.getByRole("complementary", { name: "A failed invoice payment must be recovered detail" });
  await expect(detail.locator(".rule-duration").first()).toHaveText("1 hour");
  await detail.getByRole("button", { name: "Show exact reading" }).click();
  await expect(detail.locator(".expectation-section .meaning-sentence")).toContainText("Whenever there is a failed Stripe invoice payment");
  await expect(detail.getByText("Each customer is watched separately.")).toBeVisible();
});

test("$ choices are dropdowns that version the monitor and accept typed values", async ({ page }) => {
  await page.goto("/#/assertions");
  await page.getByRole("button", { name: "Open No ghosts" }).click();
  const detail = page.getByRole("complementary", { name: "No ghosts detail" });
  const rule = detail.locator(".expectation-section");
  const environment = rule.getByRole("button", { name: "environment: production" }).first();
  await environment.focus();
  await environment.press("Enter");
  const listbox = page.getByRole("listbox", { name: "environment choices" });
  await expect(listbox).toContainText("No environment values seen yet");
  await listbox.getByLabel("Type a environment").fill("staging");
  await listbox.getByRole("button", { name: "Use" }).click();

  await expect(rule.getByRole("button", { name: "environment: staging" })).toHaveCount(3);
  const changed = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("needl.assertions.v1.ten_"));
    const saved = JSON.parse(key === undefined ? "{}" : localStorage.getItem(key) ?? "{}");
    const draft = saved.assertions.find((item: { localId: string }) => item.localId === "no-ghosts");
    return { version: draft.definition.version, values: draft.rule.values, formula: draft.definition.formula, propositions: draft.definition.propositions };
  });
  expect(changed.version).toBe(2);
  expect(changed.values).toEqual({ environment: "staging" });
  // The environment lives in the predicates; the bound formula itself is environment-independent.
  expect(JSON.stringify(changed.formula)).not.toContain("staging");
  expect(JSON.stringify(changed.propositions)).toContain("staging");
  await expect(detail.getByText("Needs attention", { exact: true })).toHaveCount(0);

  await rule.getByRole("button", { name: "environment: staging" }).first().click();
  await page.getByRole("listbox", { name: "environment choices" }).getByLabel("Type a environment").fill("production");
  await page.getByRole("listbox", { name: "environment choices" }).getByRole("button", { name: "Use" }).click();
  await expect(detail.getByText("Needs attention", { exact: true })).toBeVisible();
});

test("unsupported saved rules are preserved disabled and excluded from replay", async ({ page }) => {
  const localId = "local-eventual-preserved";
  await page.addInitScript(({ definition, localId }) => {
    const saved = [{
      localId,
      expectation: "Every paid order should eventually be fulfilled",
      definition: {
        ...definition,
        id: localId,
        name: "Every paid order should eventually be fulfilled",
        formula: { kind: "eventually", operand: { kind: "atom", name: definition.propositions[0].name } },
      },
      status: "monitoring",
      createdAt: "2026-02-18T10:39:00.000Z",
      updatedAt: "2026-02-18T10:39:00.000Z",
    }];
    localStorage.setItem("needl.assertions.v1", JSON.stringify({ version: 1, assertions: saved }));
  }, { definition: plainDefinition(localId, "Every paid order should eventually be fulfilled"), localId });

  await page.goto("/#/assertions");
  await expect(page.getByRole("button", { name: "Open Every paid order should eventually be fulfilled" })).toBeVisible();
  await expect(page.getByText("Preserved but disabled", { exact: false })).toBeVisible();
  const stored = await page.evaluate((id) => {
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("needl.assertions.v1.ten_"));
    const saved = JSON.parse(key === undefined ? "{}" : localStorage.getItem(key) ?? "{}");
    return saved.assertions.find((item: { localId: string }) => item.localId === id);
  }, localId);
  expect(stored.expectation).toBe("Every paid order should eventually be fulfilled");
  expect(stored.status).toBe("needs-review");
  expect(stored.definition.formula.kind).toBe("eventually");
});

test("a cached template-based assertion is rewritten as a rule with its choices and evidence", async ({ page }) => {
  const localId = "local-legacy-renamed-ghost";
  await page.addInitScript(({ definition, localId }) => {
    const saved = [{
      localId,
      expectation: "A legacy renamed repair stays repaired",
      definition,
      status: "monitoring",
      templateId: "ghost",
      meaning: { templateId: "ghost", values: { trigger: "fix-branch-deployed", outcome: "tagged-errors", environment: "production" } },
      createdAt: "2026-02-18T10:39:00.000Z",
      updatedAt: "2026-02-18T10:39:00.000Z",
    }];
    localStorage.setItem("needl.assertions.v1", JSON.stringify({ version: 1, assertions: saved }));
  }, { definition: { ...plainDefinition(localId, "A legacy renamed repair stays repaired"), version: 7 }, localId });

  await page.goto("/#/assertions");
  const card = page.getByTestId(`assertion-card-${localId}`);
  await expect(card.getByRole("button", { name: "environment: production" }).first()).toBeVisible();
  await card.getByRole("button", { name: "Open A legacy renamed repair stays repaired" }).click();
  const detail = page.getByRole("complementary", { name: "A legacy renamed repair stays repaired detail" });
  await expect(detail.getByText("Assertion · v8")).toBeVisible();
  await detail.getByRole("button", { name: /Counterexamples/ }).click();
  await expect(detail.locator(".counterexample").getByRole("heading", { name: "A legacy renamed repair stays repaired was broken" })).toBeVisible();
  await expect.poll(async () => page.evaluate((id) => {
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("needl.assertions.v1.ten_"));
    const saved = JSON.parse(key === undefined ? "{}" : localStorage.getItem(key) ?? "{}");
    return saved.assertions.find((item: { localId: string }) => item.localId === id)?.exampleId;
  }, localId)).toBe("no-ghosts");
});

test("a delayed pause replay cannot overwrite the newer enabled result", async ({ page }) => {
  await page.goto("/#/assertions");
  await page.getByRole("button", { name: "Open No ghosts" }).click();
  const detail = page.getByRole("complementary", { name: "No ghosts detail" });
  let releasePause!: () => void;
  let sawPause!: () => void;
  const pauseStarted = new Promise<void>((resolve) => { sawPause = resolve; });
  const pauseReleased = new Promise<void>((resolve) => { releasePause = resolve; });
  let held = false;
  await page.route("**/api/replay", async (route) => {
    const body = route.request().postDataJSON();
    const ghost = body.assertions.find((draft: { localId: string }) => draft.localId === "no-ghosts");
    if (!held && ghost?.status === "paused") {
      held = true;
      sawPause();
      await pauseReleased;
    }
    await route.continue();
  });

  await detail.getByRole("button", { name: "Pause" }).click();
  await pauseStarted;
  await detail.getByRole("button", { name: "Enable" }).click();
  await expect(detail.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(detail.locator(".detail-meta > span").filter({ hasText: "Evidence" })).toContainText("2 inputs");
  const staleResponse = page.waitForResponse((response) => {
    if (!response.url().endsWith("/api/replay")) return false;
    const body = response.request().postDataJSON();
    return body.assertions.some((draft: { localId: string; status: string }) => draft.localId === "no-ghosts" && draft.status === "paused");
  });
  releasePause();
  await staleResponse;
  await expect(detail.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(detail.locator(".detail-meta > span").filter({ hasText: "Evidence" })).toContainText("2 inputs");
});

test("a late failed replay cannot replace a newer successful replay with an error", async ({ page }) => {
  await page.goto("/#/assertions");
  await page.getByRole("button", { name: "Open No ghosts" }).click();
  const detail = page.getByRole("complementary", { name: "No ghosts detail" });
  let releasePause!: () => void;
  let sawPause!: () => void;
  const pauseStarted = new Promise<void>((resolve) => { sawPause = resolve; });
  const pauseReleased = new Promise<void>((resolve) => { releasePause = resolve; });
  let held = false;
  await page.route("**/api/replay", async (route) => {
    const body = route.request().postDataJSON();
    const ghost = body.assertions.find((draft: { localId: string }) => draft.localId === "no-ghosts");
    if (!held && ghost?.status === "paused") {
      held = true;
      sawPause();
      await pauseReleased;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await detail.getByRole("button", { name: "Pause" }).click();
  await pauseStarted;
  await detail.getByRole("button", { name: "Enable" }).click();
  await expect(detail.getByText("Needs attention", { exact: true })).toBeVisible();
  const staleFailure = page.waitForEvent("requestfailed", {
    predicate: (request) => request.url().endsWith("/api/replay")
      && request.postDataJSON().assertions.some((draft: { localId: string; status: string }) => draft.localId === "no-ghosts" && draft.status === "paused"),
  });
  releasePause();
  await staleFailure;
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(detail.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(detail.locator(".detail-meta > span").filter({ hasText: "Evidence" })).toContainText("2 inputs");
});

test("invalid restored data is rejected and replaced with safe defaults", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("needl.assertions.v1", JSON.stringify({
      version: 1,
      assertions: [{ localId: "bad", definition: { propositions: [{ predicate: { op: "eval", source: "alert(1)" } }] } }],
    }));
  });
  await page.goto("/#/assertions");
  await expect(page.locator(".assertion-card")).toHaveCount(3);
  await expect.poll(async () => page.evaluate(tenantStorage).then((saved) => saved.assertions?.length)).toBe(3);
  await expect(page.getByText("bad", { exact: true })).toHaveCount(0);
});

test("a malformed encoded assertion route falls back safely and preserves local data", async ({ page }) => {
  const localId = "local-preserved-route-probe";
  const saved = [{
    localId,
    expectation: "Preserve me across a malformed route",
    definition: plainDefinition(localId, "Preserve me across a malformed route"),
    status: "paused",
    createdAt: "2026-02-18T10:39:00.000Z",
    updatedAt: "2026-02-18T10:39:00.000Z",
  }];
  await page.evaluate((assertions) => {
    localStorage.setItem("needl.assertions.v1", JSON.stringify({ version: 1, assertions }));
  }, saved);

  await page.goto("/#/assertions/%E0%A4%A");
  await expect(page.getByRole("heading", { name: "Assertions", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Preserve me across a malformed route" })).toBeVisible();
  await expect.poll(async () => page.evaluate(tenantStorage).then((saved) => saved.assertions?.some((draft: { localId: string }) => draft.localId === "local-preserved-route-probe"))).toBe(true);
});

test("replay API returns controlled 400 responses for malformed inactive drafts", async ({ request }) => {
  const base = {
    localId: "local-api-probe",
    expectation: "A recovered error never recurs",
    definition: plainDefinition("local-api-probe", "A recovered error never recurs"),
    status: "paused",
    createdAt: "2026-02-18T10:39:00.000Z",
    updatedAt: "2026-02-18T10:39:00.000Z",
  };

  const unknownStatus = await request.post("/api/demo/replay", {
    data: { scenario: "violating", assertions: [{ ...base, status: "sleeping" }] },
  });
  expect(unknownStatus.status()).toBe(400);
  expect((await unknownStatus.json()).error).toMatch(/status/i);

  const malformedPaused = await request.post("/api/demo/replay", {
    data: {
      scenario: "violating",
      assertions: [{
        ...base,
        definition: {
          ...structuredClone(base.definition),
          formula: { kind: "always", operand: { kind: "atom", name: "undeclared_atom" } },
        },
      }],
    },
  });
  expect(malformedPaused.status()).toBe(400);
  expect((await malformedPaused.json()).error).toContain("undeclared_atom");

  const eventualPaused = await request.post("/api/demo/replay", {
    data: {
      scenario: "violating",
      assertions: [{
        ...base,
        definition: {
          ...structuredClone(base.definition),
          formula: { kind: "eventually", operand: { kind: "atom", name: base.definition.propositions[0].name } },
        },
      }],
    },
  });
  expect(eventualPaused.status()).toBe(400);
  expect((await eventualPaused.json()).error).toMatch(/no time limit/i);

  const deadlineNeedsReview = await request.post("/api/demo/replay", {
    data: {
      scenario: "violating",
      assertions: [{
        ...base,
        status: "needs-review",
        reviewReason: "Legacy deadline",
        definition: {
          ...structuredClone(base.definition),
          formula: {
            kind: "deadline",
            trigger: { kind: "atom", name: base.definition.propositions[0].name },
            response: { kind: "atom", name: base.definition.propositions[1].name },
            withinMs: 60_000,
          },
        },
      }],
    },
  });
  // A deadline is a safety property now, so a needs-review deadline is only held back until it is reviewed.
  expect(deadlineNeedsReview.status()).toBe(400);
  expect((await deadlineNeedsReview.json()).error).toMatch(/reviewed before replay/i);

  const safeNeedsReview = await request.post("/api/demo/replay", {
    data: {
      scenario: "violating",
      assertions: [{ ...base, status: "needs-review", reviewReason: "Manual review" }],
    },
  });
  expect(safeNeedsReview.status()).toBe(400);
  expect((await safeNeedsReview.json()).error).toMatch(/reviewed before replay/i);
});

test("manual authoring stops at the shared 25 assertion capacity without changing storage", async ({ page }) => {
  const assertions = Array.from({ length: 25 }, (_, index) => ({
    localId: `local-cap-${index}`,
    expectation: `Capacity rule ${index}`,
    definition: plainDefinition(`local-cap-${index}`, `Capacity rule ${index}`),
    status: "paused",
    createdAt: "2026-02-18T10:39:00.000Z",
    updatedAt: "2026-02-18T10:39:00.000Z",
  }));
  await page.evaluate((saved) => {
    localStorage.setItem("needl.assertions.v1", JSON.stringify({ version: 1, assertions: saved }));
  }, assertions);

  await page.goto("/#/assertions");
  await expect(page.locator(".assertion-card")).toHaveCount(25);
  await page.getByLabel("What should never happen?").fill("One assertion too many");
  await page.getByLabel("Continue authoring").click();
  await expect(page.getByRole("alert")).toContainText("at most 25 assertions");
  await expect(page.getByRole("dialog", { name: "Review the rule" })).toHaveCount(0);
  await expect.poll(async () => page.evaluate(tenantStorage).then((saved) => saved.assertions?.length)).toBe(25);
});

test("mobile layout has no horizontal overflow and supports detail navigation", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/assertions");
  await expect(page.getByRole("heading", { name: "Assertions", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: fileURLToPath(new URL("safety-mobile-board.png", screenshotDir)) });
  await page.getByRole("button", { name: "Open No ghosts" }).click();
  await expect(page.getByRole("complementary", { name: "No ghosts detail" }).getByRole("heading", { name: "No ghosts", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.waitForTimeout(350);
  await page.screenshot({ path: fileURLToPath(new URL("safety-mobile-detail.png", screenshotDir)) });
  await page.getByRole("button", { name: "Back to assertion board" }).click();
  await expect(page.getByRole("heading", { name: "Assertions", exact: true })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("reduced motion and missing View Transitions API use the fallback", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: undefined });
  });
  await page.goto("/#/assertions");
  await page.getByRole("button", { name: "Open No ghosts" }).click();
  await expect(page.getByRole("complementary", { name: "No ghosts detail" }).getByRole("heading", { name: "No ghosts", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to assertion board" }).click();
  await expect(page.getByRole("heading", { name: "Assertions", exact: true })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
