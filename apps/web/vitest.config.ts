import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "backend/**/*.test.ts", "demo.test.ts"],
  },
});
