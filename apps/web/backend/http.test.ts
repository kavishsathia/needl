import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDemoBootstrap } from "../demo.js";
import { defaultMeaningValues } from "../src/meaning.js";

let processHandle: ChildProcess;
let baseUrl: string;

async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) return reject(new Error("Unable to reserve test port"));
      server.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Needl test server did not become ready");
}

class BrowserSession {
  #cookies = new Map<string, string>();

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.#cookies.size > 0) headers.set("cookie", [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(";", 1);
      const separator = pair!.indexOf("=");
      const name = pair!.slice(0, separator);
      const cookieValue = pair!.slice(separator + 1);
      if (/max-age=0/i.test(value) || cookieValue.length === 0) this.#cookies.delete(name);
      else this.#cookies.set(name, cookieValue);
    }
    return response;
  }

  async json(path: string, init: RequestInit = {}): Promise<{ response: Response; body: Record<string, unknown> }> {
    const response = await this.request(path, init);
    return { response, body: await response.json() as Record<string, unknown> };
  }
}

async function signup(session: BrowserSession, email: string): Promise<void> {
  const { response } = await session.json("/api/auth/sign-up/email", {
    method: "POST", headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ name: email.split("@")[0], email, password: "correct-horse-battery-staple" }),
  });
  expect(response.status).toBe(200);
}

function sampleDraft() {
  const template = getDemoBootstrap().templates[0]!;
  return {
    localId: template.definition.id, expectation: template.prompt, definition: template.definition,
    status: "monitoring", templateId: template.id,
    meaning: { templateId: template.id, values: defaultMeaningValues(template.id) },
    createdAt: "2026-02-18T10:39:00.000Z", updatedAt: "2026-02-18T10:39:00.000Z",
  };
}

beforeAll(async () => {
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  const directory = await mkdtemp(join(tmpdir(), "needl-http-"));
  const tsx = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  processHandle = spawn(process.execPath, [tsx, "server.ts", "--api-only"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      NEEDL_SQLITE_PATH: join(directory, "needl.sqlite"),
      BETTER_AUTH_URL: baseUrl,
      NEEDL_TRUSTED_ORIGINS: baseUrl,
      BETTER_AUTH_SECRET: "needl-http-test-secret-that-is-long-enough",
    },
    stdio: "ignore",
  });
  await waitForServer(baseUrl);
}, 30_000);

afterAll(async () => {
  if (processHandle?.exitCode === null) {
    processHandle.kill("SIGTERM");
    await new Promise<void>((resolve) => processHandle.once("exit", () => resolve()));
  }
});

describe("authenticated HTTP boundaries", () => {
  it("enforces authentication and mutation origin checks", async () => {
    const anonymous = new BrowserSession();
    expect((await anonymous.request("/api/workspace")).status).toBe(401);
    expect((await anonymous.request("/api/monitor")).status).toBe(401);
    expect((await anonymous.request("/api/investigations", { method: "POST", headers: { "content-type": "application/json", "x-needl-csrf": "1" }, body: JSON.stringify({ violationId: "vio_unknown" }) })).status).toBe(401);

    const user = new BrowserSession();
    await signup(user, "csrf-user@needl.test");
    const draft = sampleDraft();
    const noOrigin = await user.request(`/api/assertions/${draft.localId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ draft }) });
    expect(noOrigin.status).toBe(403);
    const hostileOrigin = await user.request(`/api/assertions/${draft.localId}`, { method: "PUT", headers: { "content-type": "application/json", origin: "https://hostile.example" }, body: JSON.stringify({ draft }) });
    expect(hostileOrigin.status).toBe(403);
  });

  it("isolates A/B reads, deletes, monitor state, and sessions", async () => {
    const userA = new BrowserSession();
    const userB = new BrowserSession();
    await signup(userA, "tenant-a@needl.test");
    await signup(userB, "tenant-b@needl.test");
    const draft = sampleDraft();
    const save = await userA.request(`/api/assertions/${draft.localId}`, {
      method: "PUT", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ draft, expectedVersion: null }),
    });
    expect(save.status).toBe(200);

    const workspaceA = await userA.json("/api/workspace");
    const workspaceB = await userB.json("/api/workspace");
    expect(workspaceA.body.tenantId).not.toBe(workspaceB.body.tenantId);
    expect(workspaceA.body.assertions).toHaveLength(1);
    expect(workspaceB.body.assertions).toHaveLength(0);

    const deleteFromB = await userB.json(`/api/assertions/${draft.localId}`, { method: "DELETE", headers: { origin: baseUrl } });
    expect(deleteFromB.body).toEqual({ deleted: false });
    expect((await userA.json("/api/workspace")).body.assertions).toHaveLength(1);
    expect((await userB.json("/api/monitor")).body.counterexamples).toEqual([]);

    expect((await userA.request("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: "{}" })).status).toBe(200);
    expect((await userA.request("/api/workspace")).status).toBe(401);
    expect((await userB.request("/api/workspace")).status).toBe(200);
  });
});
