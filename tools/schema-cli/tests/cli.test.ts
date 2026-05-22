import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.ts";

const here = resolve(fileURLToPath(import.meta.url), "..");
const tinyFixture = resolve(here, "../../../shared/schema/tests/fixtures/tiny.yaml");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "schema-cli-"));
});

describe("runCli validate", () => {
  it("returns exit code 0 for a valid schema and prints OK", async () => {
    const out: string[] = [];
    const code = await runCli(["validate", tinyFixture], { log: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/ok/i);
  });

  it("returns non-zero and prints errors for an invalid schema", async () => {
    const invalid = join(tmp, "bad.yaml");
    writeFileSync(
      invalid,
      [
        "version: 1",
        "dimensions: []",
        "risk_classes: {}",
        "frtb_binding: {}",
        "risk_weights: {}",
        "correlations: {}",
        "",
      ].join("\n"),
    );
    const errs: string[] = [];
    const code = await runCli(["validate", invalid], {
      log: () => {},
      error: (s) => errs.push(s),
    });
    expect(code).not.toBe(0);
    expect(errs.join("\n")).toMatch(/frtb_binding/i);
  });
});

describe("runCli generate", () => {
  it("writes generated.ts and generated.schema.json into the chosen out dir", async () => {
    const outDir = join(tmp, "generated");
    const code = await runCli(["generate", tinyFixture, "--out", outDir], {
      log: () => {},
    });
    expect(code).toBe(0);
    expect(existsSync(join(outDir, "generated.ts"))).toBe(true);
    expect(existsSync(join(outDir, "generated.schema.json"))).toBe(true);

    const ts = readFileSync(join(outDir, "generated.ts"), "utf8");
    expect(ts).toMatch(/RISK_CLASS_IDS/);
    expect(ts).toMatch(/GIRR/);

    const jsonSchema = JSON.parse(
      readFileSync(join(outDir, "generated.schema.json"), "utf8"),
    );
    expect(jsonSchema.$schema).toMatch(/json-schema/);
    expect(jsonSchema.properties.risk_class.enum).toContain("GIRR");
  });

  it("returns non-zero when the input schema fails validation", async () => {
    const invalid = join(tmp, "bad.yaml");
    writeFileSync(
      invalid,
      "version: 1\ndimensions: []\nrisk_classes: {}\nfrtb_binding: {}\nrisk_weights: {}\ncorrelations: {}\n",
    );
    const errs: string[] = [];
    const code = await runCli(["generate", invalid, "--out", tmp], {
      log: () => {},
      error: (s) => errs.push(s),
    });
    expect(code).not.toBe(0);
    expect(errs.join("\n")).toMatch(/refus/i);
  });
});

describe("runCli unknown command", () => {
  it("returns non-zero and prints usage", async () => {
    const errs: string[] = [];
    const code = await runCli(["frobulate"], {
      log: () => {},
      error: (s) => errs.push(s),
    });
    expect(code).not.toBe(0);
    expect(errs.join("\n")).toMatch(/usage|unknown/i);
  });
});
