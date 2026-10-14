import { describe, expect, it } from "vitest";
import { anySecretMatches, header, stableId } from "../src/core/index.js";

describe("core helpers", () => {
  it("reads headers case-insensitively", () => {
    expect(header({ "X-Test": "value" }, "x-test")).toBe("value");
  });

  it("checks every rotation secret", () => {
    expect(anySecretMatches(["old", "current"], "CURRENT", (secret) => secret.toUpperCase())).toBe(true);
    expect(anySecretMatches(["old", "current"], "nope", (secret) => secret.toUpperCase())).toBe(false);
  });

  it("creates stable, scoped event identities", () => {
    expect(stableId(["stripe", "tenant-a", "evt_1"])).toBe(stableId(["stripe", "tenant-a", "evt_1"]));
    expect(stableId(["stripe", "tenant-a", "evt_1"])).not.toBe(stableId(["stripe", "tenant-b", "evt_1"]));
  });
});
