import { describe, it, expect } from "vitest";
import { runCli } from "../src/cli.mjs";

// Capturing IO so the test asserts the user-facing output of each subcommand
// without spawning a real Redis. The connection-bound subcommands are covered
// by the @frtb/rqe integration tests (idempotency, FT.SEARCH on TAG fields).
function captureIo() {
  const out = [];
  const err = [];
  return {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    out, err,
  };
}

describe("rqe-index-cli — argument parsing + offline subcommands", () => {
  it("with no args, prints usage and exits 2", async () => {
    const cap = captureIo();
    const code = await runCli([], cap.io);
    expect(code).toBe(2);
    expect(cap.out.join("\n")).toMatch(/usage:/);
  });

  it("'help' prints usage and exits 0", async () => {
    const cap = captureIo();
    const code = await runCli(["help"], cap.io);
    expect(code).toBe(0);
    expect(cap.out.join("\n")).toMatch(/ensure/);
    expect(cap.out.join("\n")).toMatch(/drop/);
    expect(cap.out.join("\n")).toMatch(/recreate/);
    expect(cap.out.join("\n")).toMatch(/info/);
  });

  it("'print' echoes the FT.CREATE args for idx:sens (no connection needed)", async () => {
    const cap = captureIo();
    const code = await runCli(["print"], cap.io);
    expect(code).toBe(0);
    const line = cap.out.join("\n");
    // Wave 6.38.A — idx:sens is `ON HASH` with two PREFIXes (`sens:` parent +
    // `sensh:` json-shadow-hash mirror) and a defence-in-depth FILTER.
    expect(line).toMatch(/^FT\.CREATE idx:sens ON HASH PREFIX 2 sens: sensh: FILTER exists\(@risk_class\) SCHEMA /);
    for (const tag of ["risk_class", "bucket", "sensitivity_type", "book", "trade_id"]) {
      expect(line).toMatch(new RegExp(`(^| )${tag} AS ${tag} TAG( |$)`));
    }
  });

  it("unknown command exits 2", async () => {
    const cap = captureIo();
    const code = await runCli(["bogus"], cap.io);
    expect(code).toBe(2);
    expect(cap.err.join("\n")).toMatch(/unknown command "bogus"/);
  });
});
