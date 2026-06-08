import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Wave 5.83C-1 — default CALC_FAST_PATH=0 so the legacy FCALL-stub suite
    // keeps passing without per-file env wiring. Fast-path tests opt-in.
    setupFiles: ["./vitest.setup.ts"],
  },
});
