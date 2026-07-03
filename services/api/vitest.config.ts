import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Heavy calc-sbm / differential suites each spin up a full Fastify app;
    // running many files in parallel routinely exceeds the 20s budget on CI
    // runners. Serialise file execution — still fast enough (~2–3 min total).
    fileParallelism: false,
    // Wave 5.83C-1 — default CALC_FAST_PATH=0 so the legacy FCALL-stub suite
    // keeps passing without per-file env wiring. Fast-path tests opt-in.
    setupFiles: ["./vitest.setup.ts"],
  },
});
