import type { AssertionDraft, DemoBootstrap, DemoReplay, DemoReplayRequest, TranslationProposalResponse, WorkspaceBootstrap } from "./domain.js";

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: "same-origin", ...init });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed with ${response.status}`);
  return payload;
}

export function fetchBootstrap(): Promise<DemoBootstrap> {
  return requestJson("/api/demo/bootstrap");
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
