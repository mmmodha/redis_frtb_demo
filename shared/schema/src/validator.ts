import type {
  CorrelationSpec,
  Dimension,
  DimensionType,
  FrtbBinding,
  Schema,
} from "./types.ts";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const LEGAL_TYPES: DimensionType[] = [
  "TAG",
  "NUMERIC",
  "TEXT",
  "GEO",
  "VECTOR",
  "ARRAY_NUMERIC",
];

const FRTB_BINDING_FIELDS: (keyof FrtbBinding)[] = [
  "risk_class",
  "bucket",
  "tenor",
  "risk_value",
  "weight",
  "sensitivity_type",
];

export function validateSchema(schema: Schema): ValidationResult {
  const errors: string[] = [];
  const dimsByName = new Map<string, Dimension>();
  for (const d of schema.dimensions ?? []) {
    if (!LEGAL_TYPES.includes(d.type)) {
      errors.push(`dimension ${d.name} has illegal type ${d.type}`);
    }
    dimsByName.set(d.name, d);
  }

  const anyPrimary = (schema.dimensions ?? []).some(
    (d) => d.hash_tag_role === "primary",
  );
  if (!anyPrimary) {
    errors.push(
      "at least one dimension must have hash_tag_role: primary (required for rollup-key hash-tag construction; sens-doc keys themselves are brace-less sens:{ulid})",
    );
  }

  for (const field of FRTB_BINDING_FIELDS) {
    const target = schema.frtb_binding?.[field];
    if (!target) {
      errors.push(`frtb_binding.${field} is required`);
    } else if (!dimsByName.has(target)) {
      errors.push(
        `frtb_binding.${field} references unknown dimension ${target}`,
      );
    }
  }

  for (const [className, cfg] of Object.entries(schema.risk_classes ?? {})) {
    for (const dimName of cfg.dimensions ?? []) {
      if (!dimsByName.has(dimName)) {
        errors.push(
          `risk class ${className} references unknown dimension ${dimName}`,
        );
      }
    }
    if (!schema.risk_weights?.[cfg.risk_weights_ref]) {
      errors.push(
        `risk class ${className} risk_weights_ref ${cfg.risk_weights_ref} is not defined in risk_weights`,
      );
    }
    if (!schema.correlations?.[cfg.intra_bucket_correlation_ref]) {
      errors.push(
        `risk class ${className} intra_bucket_correlation_ref ${cfg.intra_bucket_correlation_ref} is not defined in correlations`,
      );
    }
    if (!schema.correlations?.[cfg.cross_bucket_correlation_ref]) {
      errors.push(
        `risk class ${className} cross_bucket_correlation_ref ${cfg.cross_bucket_correlation_ref} is not defined in correlations`,
      );
    }
  }

  for (const [name, corr] of Object.entries(schema.correlations ?? {})) {
    errors.push(...validateCorrelation(name, corr));
  }

  return { ok: errors.length === 0, errors };
}

function validateCorrelation(name: string, corr: CorrelationSpec): string[] {
  const errors: string[] = [];
  if (corr.kind === "matrix") {
    const n = corr.labels?.length ?? 0;
    if (n === 0) {
      errors.push(`correlation ${name} matrix has no labels`);
      return errors;
    }
    if (corr.matrix.length !== n) {
      errors.push(
        `correlation ${name} matrix has ${corr.matrix.length} rows but ${n} labels`,
      );
    }
    for (let i = 0; i < corr.matrix.length; i++) {
      const row = corr.matrix[i]!;
      if (row.length !== n) {
        errors.push(
          `correlation ${name} matrix row ${i} has length ${row.length}, expected ${n}`,
        );
      }
    }
  }
  return errors;
}
