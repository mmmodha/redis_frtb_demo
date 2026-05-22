import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSchema, validateSchema, RISK_CLASSES } from "@frtb/schema";
import type { Schema } from "@frtb/schema";

export interface CliIO {
  log?: (s: string) => void;
  error?: (s: string) => void;
}

const USAGE = `usage:
  schema-cli validate <schema.yaml>
  schema-cli generate <schema.yaml> --out <dir>`;

export async function runCli(argv: string[], io: CliIO = {}): Promise<number> {
  const log = io.log ?? ((s) => console.log(s));
  const error = io.error ?? ((s) => console.error(s));
  const [cmd, ...rest] = argv;

  if (cmd === "validate") return cmdValidate(rest, log, error);
  if (cmd === "generate") return cmdGenerate(rest, log, error);
  error(`unknown command "${cmd ?? ""}"\n${USAGE}`);
  return 2;
}

function cmdValidate(
  args: string[],
  log: (s: string) => void,
  error: (s: string) => void,
): number {
  const path = args[0];
  if (!path) {
    error(`validate requires a schema path\n${USAGE}`);
    return 2;
  }
  let schema: Schema;
  try {
    schema = loadSchema(path);
  } catch (e) {
    error(String((e as Error).message));
    return 1;
  }
  const result = validateSchema(schema);
  if (!result.ok) {
    for (const err of result.errors) error(err);
    return 1;
  }
  log(`ok: ${path} validated (${schema.dimensions.length} dims, ${
    Object.keys(schema.risk_classes).length
  } risk classes)`);
  return 0;
}

function cmdGenerate(
  args: string[],
  log: (s: string) => void,
  error: (s: string) => void,
): number {
  const path = args[0];
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined;
  if (!path || !outDir) {
    error(`generate requires <schema.yaml> --out <dir>\n${USAGE}`);
    return 2;
  }
  let schema: Schema;
  try {
    schema = loadSchema(path);
  } catch (e) {
    error(String((e as Error).message));
    return 1;
  }
  const result = validateSchema(schema);
  if (!result.ok) {
    error(`refusing to generate from invalid schema:`);
    for (const err of result.errors) error(`  - ${err}`);
    return 1;
  }
  mkdirSync(resolve(outDir), { recursive: true });
  writeFileSync(resolve(outDir, "generated.ts"), emitTs(schema));
  writeFileSync(
    resolve(outDir, "generated.schema.json"),
    JSON.stringify(emitJsonSchema(schema), null, 2),
  );
  log(`generated ${outDir}/generated.ts and generated.schema.json`);
  return 0;
}

function emitTs(schema: Schema): string {
  const classes = Object.keys(schema.risk_classes);
  const lines: string[] = [
    "// AUTO-GENERATED — do not edit by hand.",
    "// Produced by @frtb/schema-cli from the active schema YAML.",
    "",
    `export const RISK_CLASS_IDS = [${classes.map((c) => JSON.stringify(c)).join(", ")}] as const;`,
    "export type RiskClassIdGenerated = (typeof RISK_CLASS_IDS)[number];",
    "",
    `export const ALL_RISK_CLASSES = ${JSON.stringify(RISK_CLASSES)} as const;`,
    "",
    `export const BUCKETS: Record<RiskClassIdGenerated, readonly string[]> = ${JSON.stringify(
      Object.fromEntries(
        classes.map((c) => [c, schema.risk_classes[c]!.buckets.values]),
      ),
      null,
      2,
    )} as const;`,
    "",
  ];
  for (const c of classes) {
    const dims = schema.risk_classes[c]!.dimensions;
    const fields = dims.map((d) => `  ${d}: unknown;`).join("\n");
    lines.push(
      `export interface ${c}Sensitivity {`,
      `  risk_class: "${c}";`,
      fields,
      `}`,
      "",
    );
  }
  const union = classes.map((c) => `${c}Sensitivity`).join(" | ");
  lines.push(
    `export type GeneratedSensitivity = ${union || "never"};`,
    "",
  );
  return lines.join("\n");
}

function emitJsonSchema(schema: Schema): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "FRTB Sensitivity",
    type: "object",
    required: ["risk_class", "bucket", "risk_value", "sensitivity_type"],
    properties: {
      risk_class: { type: "string", enum: Object.keys(schema.risk_classes) },
      bucket: { type: "string" },
      tenor: { type: "string" },
      risk_value: {
        oneOf: [
          { type: "number" },
          { type: "array", items: { type: "number" } },
        ],
      },
      weight: { type: "number" },
      sensitivity_type: { type: "string", enum: ["DELTA", "VEGA", "CURVATURE"] },
    },
    additionalProperties: true,
  };
}
