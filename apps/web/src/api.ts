import type { DemoBootstrap, DemoReplay, DemoReplayRequest } from "./domain.js";

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed with ${response.status}`);
  return payload;
}

export function fetchBootstrap(): Promise<DemoBootstrap> {
  return requestJson("/api/demo/bootstrap");
}

export function replayDemo(request: DemoReplayRequest): Promise<DemoReplay> {
  return requestJson("/api/demo/replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
}
