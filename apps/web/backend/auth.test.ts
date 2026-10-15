import { describe, expect, it } from "vitest";
import { signupEnabled } from "./auth.js";

describe("production signup policy", () => {
  it("is closed by default and opens only for an explicit email allowlist", () => {
    expect(signupEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(signupEnabled({ NODE_ENV: "production", NEEDL_SIGNUP_ALLOWLIST: "approved@needl.test" })).toBe(true);
    expect(signupEnabled({ NODE_ENV: "test" })).toBe(true);
  });
});
