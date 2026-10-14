import { expect, test, type Page } from "@playwright/test";
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

test.beforeEach(async ({ page }) => {
  await page.goto("/api/health");
  await page.evaluate(() => localStorage.clear());
});

test("complete assertion journey uses engine evidence and persists authored state", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.goto("/#/assertions");
  await expect(page.getByRole("heading", { name: "Assertions", exact: true })).toBeVisible();
  await expect(page.getByText("Deterministic demo")).toBeVisible();
  await expect(page.locator(".assertion-card")).toHaveCount(3);

  await page.screenshot({ path: new URL("needl-desktop.png", screenshotDir).pathname, fullPage: true });

  await page.getByLabel("Describe an expectation").fill("Every checkout fix stays fixed after deployment");
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
  await page.screenshot({ path: new URL("needl-desktop-detail.png", screenshotDir).pathname, fullPage: true });

  await detail.getByRole("button", { name: "Edit rule" }).click();
  const expectation = page.getByLabel("Expectation", { exact: true });
  await expectation.fill("A checkout fix must stay fixed after deployment");
  await page.getByRole("button", { name: /Validate & save v2/ }).click();
  await expect(detail.getByRole("heading", { name: "A checkout fix must stay fixed after deployment" })).toBeVisible();
  await expect(page.getByText("Assertion · v2")).toBeVisible();

  await page.reload();
  await expect(detail.getByRole("heading", { name: "A checkout fix must stay fixed after deployment" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Pause" })).toBeVisible();

  await page.getByRole("button", { name: /Counterexamples/ }).click();
  await expect(page.getByText(/progressed LTL formula became false/)).toBeVisible();
  await expect(page.locator(".trace-timeline li")).toHaveCount(3);
  await expect(page.getByText("sentry", { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "Back to assertion board" }).click();
  await expect(page.getByRole("heading", { name: "Assertions", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open A checkout fix must stay fixed after deployment" })).toBeFocused();

  await page.getByRole("tab", { name: "Needs attention" }).click();
  await expect(page.locator(".assertion-card")).toHaveCount(4);
  await page.getByPlaceholder("Search Acme / Production").fill("kill switch");
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

test("invalid restored data is rejected and replaced with safe defaults", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("needl.assertions.v1", JSON.stringify({
      version: 1,
      assertions: [{ localId: "bad", definition: { propositions: [{ predicate: { op: "eval", source: "alert(1)" } }] } }],
    }));
  });
  await page.goto("/#/assertions");
  await expect(page.locator(".assertion-card")).toHaveCount(3);
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem("needl.assertions.v1") ?? "{}").assertions?.length)).toBe(3);
  await expect(page.getByText("bad", { exact: true })).toHaveCount(0);
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
  await page.getByLabel("Describe an expectation").fill("One assertion too many");
  await page.getByLabel("Continue authoring").click();
  await expect(page.getByRole("alert")).toContainText("at most 25 assertions");
  await expect(page.getByRole("dialog", { name: "Choose an interpretation template" })).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem("needl.assertions.v1") ?? "{}").assertions?.length)).toBe(25);
});

test("mobile layout has no horizontal overflow and supports detail navigation", async ({ page }) => {
  const consoleErrors = watchConsole(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/assertions");
  await expect(page.getByRole("heading", { name: "Assertions", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: new URL("needl-mobile.png", screenshotDir).pathname, fullPage: true });
  await page.getByRole("button", { name: "Open Fixed means fixed" }).click();
  await expect(page.getByRole("complementary", { name: "Fixed means fixed detail" }).getByRole("heading", { name: "Fixed means fixed" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.waitForTimeout(350);
  await page.screenshot({ path: new URL("needl-mobile-detail.png", screenshotDir).pathname, fullPage: true });
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
