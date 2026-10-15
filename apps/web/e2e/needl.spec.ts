import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";

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
  await expect(page.getByText("Deterministic demo")).toBeVisible();
  await expect(page.locator(".assertion-card")).toHaveCount(3);

  await page.screenshot({ path: new URL("safety-desktop-board.png", screenshotDir).pathname, fullPage: true });

  await page.getByLabel("What should never happen?").fill("Every checkout fix stays fixed after deployment");
  await page.getByLabel("Continue authoring").click();
  await expect(page.getByRole("heading", { name: "Choose an interpretation template" })).toBeVisible();
  await expect(page.getByText("Natural-language AI translation is not configured.")).toBeVisible();
  await page.getByRole("dialog", { name: "Choose an interpretation template" }).getByRole("button", { name: /Fixed means fixed/ }).click();

  const detail = page.locator(".detail");
  await expect(detail.getByRole("heading", { name: "Every checkout fix stays fixed after deployment" })).toBeVisible();
  await expect(detail.getByText("Paused", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "Enable" }).click();
  await expect(detail.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(detail.getByText("Needs attention", { exact: true })).toBeVisible();
  await page.waitForTimeout(2800);

  await detail.getByRole("button", { name: "Edit wording" }).click();
  const expectation = page.getByLabel("Expectation", { exact: true });
  await expectation.fill("A checkout fix must stay fixed after deployment");
  await page.getByRole("button", { name: /Validate & save v2/ }).click();
  await expect(detail.getByRole("heading", { name: "A checkout fix must stay fixed after deployment" })).toBeVisible();
  await expect(page.getByText("Assertion · v2")).toBeVisible();

  await page.reload();
  await expect(detail.getByRole("heading", { name: "A checkout fix must stay fixed after deployment" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Pause" })).toBeVisible();

  await page.getByRole("button", { name: /Counterexamples/ }).click();
  const counterexample = detail.locator(".counterexample");
  await expect(counterexample.getByRole("heading", { name: "The linked issue occurred again after a fix was deployed in Production." })).toBeVisible();
  await expect(counterexample.getByText(/progressed LTL formula became false/)).toBeHidden();
  await expect(counterexample.getByText(/formula false/i)).toBeHidden();
  await expect(page.locator(".trace-timeline li")).toHaveCount(3);
  await expect(page.getByText("sentry", { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: new URL("safety-desktop-evidence.png", screenshotDir).pathname, fullPage: true });

  await page.getByRole("button", { name: "Back to assertion board" }).click();
  await expect(page.getByRole("heading", { name: "Assertions", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open A checkout fix must stay fixed after deployment" })).toBeFocused();

  await page.getByRole("tab", { name: "Needs attention" }).click();
  await expect(page.locator(".assertion-card")).toHaveCount(4);
  await page.getByPlaceholder("Search Acme / Production").fill("disabled");
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

test("authored clones and wording edits keep canonical chips and meaning-first counterexamples for every template", async ({ page }) => {
  const cases = [
    {
      expectation: "A renamed checkout repair never regresses",
      template: /Fixed means fixed/,
      editedName: "A renamed checkout repair stays repaired",
      cardMeaning: "After a fix is deployed, the linked issue must not occur again in Production.",
      violation: "The linked issue occurred again after a fix was deployed in Production.",
      chip: "Trigger: a fix is deployed",
    },
    {
      expectation: "A renamed disabled rollout stays quiet",
      template: /Off means off/,
      cardMeaning: "While checkout-v2 is disabled, errors from the feature must not occur.",
      violation: "Errors from checkout-v2 occurred while the feature was disabled.",
      chip: "Feature: checkout-v2",
    },
    {
      expectation: "A renamed order cannot ship before payment",
      template: /Payment before fulfillment/,
      cardMeaning: "After an order is accepted, order ord_1042 must not be fulfilled before payment is observed.",
      violation: "Order ord_1042 was fulfilled before its payment was observed.",
      chip: "Observed lifecycle boundary: an order is accepted",
    },
  ] as const;

  await page.goto("/#/assertions");
  for (const item of cases) {
    await page.getByLabel("What should never happen?").fill(item.expectation);
    await page.getByLabel("Continue authoring").click();
    await page.getByRole("dialog", { name: "Choose an interpretation template" }).getByRole("button", { name: item.template }).click();
    const detail = page.getByRole("complementary", { name: `${item.expectation} detail` });
    await detail.getByRole("button", { name: "Enable" }).click();
    await expect(detail.getByText("Needs attention", { exact: true })).toBeVisible();

    let currentName: string = item.expectation;
    if ("editedName" in item) {
      await detail.getByRole("button", { name: "Edit wording" }).click();
      await page.getByLabel("Expectation", { exact: true }).fill(item.editedName);
      await page.getByRole("button", { name: /Validate & save v2/ }).click();
      currentName = item.editedName;
    }

    const currentDetail = page.getByRole("complementary", { name: `${currentName} detail` });
    await currentDetail.getByRole("button", { name: /Counterexamples/ }).click();
    const counterexample = currentDetail.locator(".counterexample");
    await expect(counterexample.getByRole("heading", { name: item.violation })).toBeVisible();
    await expect(counterexample.getByText(/progressed LTL formula became false/)).toBeHidden();
    await expect(counterexample.getByText(/formula false/i)).toBeHidden();
    await page.getByRole("button", { name: "Back to assertion board" }).click();

    const card = page.getByTestId(`assertion-card-local-${item.expectation.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36)}`);
    await expect(card.locator(".meaning-sentence")).toHaveText(item.cardMeaning);
    await expect(card.getByRole("button", { name: item.chip })).toBeVisible();
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

test("eventuality authoring requires a confirmed safety alternative and keeps advanced syntax secondary", async ({ page }) => {
  await page.goto("/#/assertions");
  await page.getByLabel("What should never happen?").fill("Every paid order should eventually be fulfilled");
  await page.getByLabel("Continue authoring").click();

  const unsupported = page.getByRole("dialog", { name: "Need a breakable condition" });
  await expect(unsupported).toContainText("This describes something that should eventually happen. Needl needs a condition it can catch being broken.");
  await expect(page.getByRole("dialog", { name: "Choose an interpretation template" })).toHaveCount(0);
  await unsupported.getByRole("button", { name: "Use this alternative" }).click();

  const chooser = page.getByRole("dialog", { name: "Choose an interpretation template" });
  await expect(chooser).toContainText("Orders must not be fulfilled before payment is observed");
  await chooser.getByRole("button", { name: /Payment before fulfillment/ }).click();
  const detail = page.locator(".detail");
  await expect(detail.getByText("Orders must not be fulfilled before payment is observed", { exact: true }).first()).toBeVisible();
  await expect(detail.locator(".formula-block")).toHaveCount(0);

  await detail.getByRole("button", { name: "Edit wording" }).click();
  await expect(page.getByLabel("Formula")).toBeHidden();
  await page.getByText("Advanced specification", { exact: true }).click();
  await expect(page.getByLabel("Formula")).toBeVisible();
});

test("meaning chips update canonical semantics and link phrases to trace evidence by keyboard and mouse", async ({ page }) => {
  await page.goto("/#/assertions");
  await page.getByRole("button", { name: "Open Fixed means fixed" }).click();
  const detail = page.getByRole("complementary", { name: "Fixed means fixed detail" });
  const rule = detail.locator(".expectation-section");
  const environment = rule.getByRole("button", { name: "Environment: Production" });
  await environment.focus();
  await environment.press("Enter");
  await page.getByRole("option", { name: /Staging/ }).press("Enter");

  await expect(detail.getByRole("heading", { name: "No matching evidence" })).toBeVisible();
  const changed = await page.evaluate(() => {
    const saved = tenantStorage();
    const draft = saved.assertions.find((item: { localId: string }) => item.localId === "linked-issue-recurrence");
    return { version: draft.definition.version, formula: draft.definition.formula, propositions: draft.definition.propositions, scope: draft.definition.scope };
  });
  expect(changed.version).toBe(2);
  expect(JSON.stringify(changed.formula)).toContain("staging");
  expect(JSON.stringify(changed.propositions)).toContain("staging");
  expect(JSON.stringify(changed.scope)).toContain("staging");

  await rule.getByRole("button", { name: "Environment: Staging" }).click();
  await page.getByRole("option", { name: /Production/ }).click();
  await expect(detail.getByText("Needs attention", { exact: true })).toBeVisible();
  const outcome = rule.getByRole("button", { name: "Forbidden outcome: occur again" });
  await outcome.focus();
  await outcome.press("Enter");
  await expect(detail.locator(".trace-timeline li.is-meaning-linked").filter({ hasText: "Sentry" })).toBeVisible();

  const gitlabEvidence = detail.locator(".trace-timeline li").filter({ hasText: "GitLab" });
  await gitlabEvidence.getByRole("button", { name: "Highlight trigger in the rule" }).click();
  await expect(rule.getByRole("button", { name: "Trigger: a fix is deployed" })).toHaveClass(/is-linked/);
});

test("unsupported saved rules are preserved disabled and excluded from replay", async ({ page, request }) => {
  const bootstrap = await (await request.get("/api/demo/bootstrap")).json();
  const template = bootstrap.templates[0];
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
  }, { definition: template.definition, localId });

  await page.goto("/#/assertions");
  await expect(page.getByRole("button", { name: "Open Every paid order should eventually be fulfilled" })).toBeVisible();
  await expect(page.getByText("Preserved but disabled", { exact: false })).toBeVisible();
  const stored = await page.evaluate((id) => {
    const saved = tenantStorage();
    return saved.assertions.find((item: { localId: string }) => item.localId === id);
  }, localId);
  expect(stored.expectation).toBe("Every paid order should eventually be fulfilled");
  expect(stored.status).toBe("needs-review");
  expect(stored.definition.formula.kind).toBe("eventually");
});

test("migration restores canonical chips and business evidence for a legacy authored clone with a renamed ID", async ({ page, request }) => {
  const bootstrap = await (await request.get("/api/demo/bootstrap")).json();
  const template = bootstrap.templates.find((item: { id: string }) => item.id === "recurrence");
  const localId = "local-legacy-renamed-recurrence";
  await page.addInitScript(({ definition, localId }) => {
    const saved = [{
      localId,
      expectation: "A legacy renamed repair stays repaired",
      definition: { ...definition, id: localId, name: "A legacy renamed repair stays repaired", version: 7 },
      status: "monitoring",
      templateId: "recurrence",
      createdAt: "2026-02-18T10:39:00.000Z",
      updatedAt: "2026-02-18T10:39:00.000Z",
    }];
    localStorage.setItem("needl.assertions.v1", JSON.stringify({ version: 1, assertions: saved }));
  }, { definition: template.definition, localId });

  await page.goto("/#/assertions");
  const card = page.getByTestId(`assertion-card-${localId}`);
  await expect(card.getByRole("button", { name: "Trigger: a fix is deployed" })).toBeVisible();
  await card.getByRole("button", { name: "Open A legacy renamed repair stays repaired" }).click();
  const detail = page.getByRole("complementary", { name: "A legacy renamed repair stays repaired detail" });
  await detail.getByRole("button", { name: /Counterexamples/ }).click();
  await expect(detail.locator(".counterexample").getByRole("heading", { name: "The linked issue occurred again after a fix was deployed in Production." })).toBeVisible();
  await expect.poll(async () => page.evaluate((id) => {
    const saved = tenantStorage();
    return saved.assertions.find((item: { localId: string }) => item.localId === id)?.meaning?.templateId;
  }, localId)).toBe("recurrence");
});

test("a delayed pause replay cannot overwrite the newer enabled result", async ({ page }) => {
  await page.goto("/#/assertions");
  await page.getByRole("button", { name: "Open Fixed means fixed" }).click();
  const detail = page.getByRole("complementary", { name: "Fixed means fixed detail" });
  let releasePause!: () => void;
  let sawPause!: () => void;
  const pauseStarted = new Promise<void>((resolve) => { sawPause = resolve; });
  const pauseReleased = new Promise<void>((resolve) => { releasePause = resolve; });
  let held = false;
  await page.route("**/api/replay", async (route) => {
    const body = route.request().postDataJSON();
    const recurrence = body.assertions.find((draft: { localId: string }) => draft.localId === "linked-issue-recurrence");
    if (!held && recurrence?.status === "paused") {
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
  await expect(detail.locator(".detail-meta > span").filter({ hasText: "Evidence" })).toContainText("3 inputs");
  const staleResponse = page.waitForResponse((response) => {
    if (!response.url().endsWith("/api/replay")) return false;
    const body = response.request().postDataJSON();
    return body.assertions.some((draft: { localId: string; status: string }) => draft.localId === "linked-issue-recurrence" && draft.status === "paused");
  });
  releasePause();
  await staleResponse;
  await expect(detail.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(detail.locator(".detail-meta > span").filter({ hasText: "Evidence" })).toContainText("3 inputs");
});

test("a late failed replay cannot replace a newer successful replay with an error", async ({ page }) => {
  await page.goto("/#/assertions");
  await page.getByRole("button", { name: "Open Fixed means fixed" }).click();
  const detail = page.getByRole("complementary", { name: "Fixed means fixed detail" });
  let releasePause!: () => void;
  let sawPause!: () => void;
  const pauseStarted = new Promise<void>((resolve) => { sawPause = resolve; });
  const pauseReleased = new Promise<void>((resolve) => { releasePause = resolve; });
  let held = false;
  await page.route("**/api/replay", async (route) => {
    const body = route.request().postDataJSON();
    const recurrence = body.assertions.find((draft: { localId: string }) => draft.localId === "linked-issue-recurrence");
    if (!held && recurrence?.status === "paused") {
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
      && request.postDataJSON().assertions.some((draft: { localId: string; status: string }) => draft.localId === "linked-issue-recurrence" && draft.status === "paused"),
  });
  releasePause();
  await staleFailure;
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(detail.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(detail.locator(".detail-meta > span").filter({ hasText: "Evidence" })).toContainText("3 inputs");
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

test("a malformed encoded assertion route falls back safely and preserves local data", async ({ page, request }) => {
  const bootstrap = await (await request.get("/api/demo/bootstrap")).json();
  const template = bootstrap.templates[0];
  const localId = "local-preserved-route-probe";
  const saved = [{
    localId,
    expectation: "Preserve me across a malformed route",
    definition: { ...structuredClone(template.definition), id: localId, name: "Preserve me across a malformed route" },
    status: "paused",
    templateId: template.id,
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
  const bootstrap = await (await request.get("/api/demo/bootstrap")).json();
  const template = bootstrap.templates[0];
  const base = {
    localId: template.definition.id,
    expectation: template.prompt,
    definition: template.definition,
    status: "paused",
    templateId: template.id,
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
  expect((await eventualPaused.json()).error).toMatch(/eventually happen/i);

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
  expect(deadlineNeedsReview.status()).toBe(400);
  expect((await deadlineNeedsReview.json()).error).toMatch(/deadline/i);

  const safeNeedsReview = await request.post("/api/demo/replay", {
    data: {
      scenario: "violating",
      assertions: [{ ...base, status: "needs-review", reviewReason: "Manual review" }],
    },
  });
  expect(safeNeedsReview.status()).toBe(400);
  expect((await safeNeedsReview.json()).error).toMatch(/reviewed before replay/i);
});

test("manual authoring stops at the shared 25 assertion capacity without changing storage", async ({ page, request }) => {
  const bootstrap = await (await request.get("/api/demo/bootstrap")).json();
  const assertions = [...bootstrap.templates.map((template: { prompt: string; id: string; definition: object }) => ({
    localId: (template.definition as { id: string }).id,
    expectation: template.prompt,
    definition: template.definition,
    status: "monitoring",
    templateId: template.id,
    createdAt: "2026-02-18T10:39:00.000Z",
    updatedAt: "2026-02-18T10:39:00.000Z",
  }))];
  const template = bootstrap.templates[0];
  for (let index = assertions.length; index < 25; index += 1) {
    const localId = `local-cap-${index}`;
    assertions.push({
      localId,
      expectation: `Capacity rule ${index}`,
      definition: { ...structuredClone(template.definition), id: localId, name: `Capacity rule ${index}` },
      status: "paused",
      templateId: template.id,
      createdAt: "2026-02-18T10:39:00.000Z",
      updatedAt: "2026-02-18T10:39:00.000Z",
    });
  }
  await page.evaluate((saved) => {
    localStorage.setItem("needl.assertions.v1", JSON.stringify({ version: 1, assertions: saved }));
  }, assertions);

  await page.goto("/#/assertions");
  await expect(page.locator(".assertion-card")).toHaveCount(25);
  await page.getByLabel("What should never happen?").fill("One assertion too many");
  await page.getByLabel("Continue authoring").click();
  await expect(page.getByRole("alert")).toContainText("at most 25 assertions");
  await expect(page.getByRole("dialog", { name: "Choose an interpretation template" })).toHaveCount(0);
  await expect.poll(async () => page.evaluate(tenantStorage).then((saved) => saved.assertions?.length)).toBe(25);
});

test("mobile layout has no horizontal overflow and supports detail navigation", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/assertions");
  await expect(page.getByRole("heading", { name: "Assertions", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: new URL("safety-mobile-board.png", screenshotDir).pathname });
  await page.getByRole("button", { name: "Open Fixed means fixed" }).click();
  await expect(page.getByRole("complementary", { name: "Fixed means fixed detail" }).getByRole("heading", { name: "Fixed means fixed" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.waitForTimeout(350);
  await page.screenshot({ path: new URL("safety-mobile-detail.png", screenshotDir).pathname });
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
  await page.getByRole("button", { name: "Open Fixed means fixed" }).click();
  await expect(page.getByRole("complementary", { name: "Fixed means fixed detail" }).getByRole("heading", { name: "Fixed means fixed" })).toBeVisible();
  await page.getByRole("button", { name: "Back to assertion board" }).click();
  await expect(page.getByRole("heading", { name: "Assertions", exact: true })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
