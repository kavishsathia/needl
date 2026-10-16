import type { AssertionDraft, ChoiceSuggestions, Connection, ConnectionsResponse, DemoBootstrap, DemoReplay, DemoReplayRequest, InvestigationRecord, MonitorSnapshot, TranslationProposalResponse, WorkspaceBootstrap } from "./domain.js";

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: "same-origin", ...init });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed with ${response.status}`);
  return payload;
}

export function fetchBootstrap(): Promise<DemoBootstrap> {
  return requestJson("/api/demo/bootstrap");
}

export function fetchPublicConfig(): Promise<{ readonly signupEnabled: boolean }> {
  return requestJson("/api/config");
}

export function replayDemo(request: DemoReplayRequest): Promise<DemoReplay> {
  return requestJson("/api/replay", {
    method: "POST",
    headers: { "content-type": "application/json", "x-needl-csrf": "1" },
    body: JSON.stringify(request),
  });
}

export function fetchWorkspace(): Promise<WorkspaceBootstrap> {
  return requestJson("/api/workspace");
}

export function fetchMonitor(): Promise<MonitorSnapshot> {
  return requestJson("/api/monitor");
}

export function signUp(input: { readonly name: string; readonly email: string; readonly password: string }): Promise<unknown> {
  return requestJson("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}

export function signIn(input: { readonly email: string; readonly password: string }): Promise<unknown> {
  return requestJson("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}

export function signOut(): Promise<unknown> {
  return requestJson("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
}

export function saveAssertion(draft: AssertionDraft, expectedVersion?: number): Promise<AssertionDraft> {
  return requestJson(`/api/assertions/${encodeURIComponent(draft.localId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-needl-csrf": "1" },
    body: JSON.stringify({ draft, expectedVersion: expectedVersion ?? null }),
  });
}

export function removeAssertion(id: string): Promise<{ readonly deleted: boolean }> {
  return requestJson(`/api/assertions/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "content-type": "application/json", "x-needl-csrf": "1" } });
}

export function translateAssertion(text: string): Promise<TranslationProposalResponse> {
  return requestJson("/api/translations", { method: "POST", headers: { "content-type": "application/json", "x-needl-csrf": "1" }, body: JSON.stringify({ text }) });
}

export function confirmTranslation(proposalId: string): Promise<unknown> {
  return requestJson(`/api/translations/${encodeURIComponent(proposalId)}/confirm`, { method: "POST", headers: { "content-type": "application/json", "x-needl-csrf": "1" }, body: "{}" });
}

export function launchInvestigation(violationId: string): Promise<InvestigationRecord> {
  return requestJson("/api/investigations", { method: "POST", headers: { "content-type": "application/json", "x-needl-csrf": "1" }, body: JSON.stringify({ violationId }) });
}

export function refreshInvestigation(id: string): Promise<InvestigationRecord> {
  return requestJson(`/api/investigations/${encodeURIComponent(id)}/refresh`, { method: "POST", headers: { "content-type": "application/json", "x-needl-csrf": "1" }, body: "{}" });
}

export function fetchChoiceSuggestions(source: string): Promise<{ readonly suggestions: readonly ChoiceSuggestions[] }> {
  return requestJson("/api/rules/suggestions", { method: "POST", headers: { "content-type": "application/json", "x-needl-csrf": "1" }, body: JSON.stringify({ source }) });
}

const mutation = { "content-type": "application/json", "x-needl-csrf": "1" };

export function fetchConnections(): Promise<ConnectionsResponse> {
  return requestJson("/api/connections");
}

export function createConnection(provider: string): Promise<Connection> {
  return requestJson("/api/connections", { method: "POST", headers: mutation, body: JSON.stringify({ provider }) });
}

export function saveConnectionSecret(id: string, secret: string, mode?: string): Promise<Connection> {
  return requestJson(`/api/connections/${encodeURIComponent(id)}/secret`, { method: "PUT", headers: mutation, body: JSON.stringify({ secret, ...(mode === undefined ? {} : { mode }) }) });
}

export function deleteConnection(id: string): Promise<{ readonly deleted: boolean }> {
  return requestJson(`/api/connections/${encodeURIComponent(id)}`, { method: "DELETE", headers: mutation });
}
