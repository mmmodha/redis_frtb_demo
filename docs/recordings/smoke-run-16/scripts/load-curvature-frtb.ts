// Wave 5.16e2 one-off runtime helper.
//
// Production bootstrap (services/api/src/bootstrap.ts) only registers the six
// Delta+Vega snippets. The three Curvature snippets (Wave 5.16a/b) exist as
// public exports but are not yet wired into the live FUNCTION LOAD list — see
// docs/recordings/smoke-run-16/SUMMARY.md for the named gap. This helper
// rebuilds the full 9-function `frtb` library (FUNCTION LOAD REPLACE is
// idempotent and atomic, so reloading does not disturb in-flight FCALL traffic
// against the already-registered Delta/Vega entries) so the smoke-run-16
// evidence pack can exercise all 9 (risk_class × leg) combinations on the
// same Redis instance the api uses.
//
// Lives under docs/recordings/smoke-run-16/scripts/ to honour the "no src/
// change" scope; imports are pinned to the existing public snippet builders.
// Secrets policy: REDIS_URL is read from env and never echoed.
import { Redis, Cluster } from "ioredis";
import { createRedisClient } from "@frtb/redis-client";
import { loadSchema } from "@frtb/schema";
import {
  buildFrtbSnippets,
  resolveMasterNodes,
} from "../../../../services/api/src/bootstrap.ts";
import {
  loadFrtbLibrary,
  type FrtbLibrarySnippet,
} from "../../../../services/calc/src/loadFrtbLibrary.ts";
import { buildGirrCurvatureSnippet } from "../../../../services/calc/src/girrCurvatureSnippet.ts";
import { buildEquityCurvatureSnippet } from "../../../../services/calc/src/equityCurvatureSnippet.ts";
import { buildFxCurvatureSnippet } from "../../../../services/calc/src/fxCurvatureSnippet.ts";

async function main(): Promise<void> {
  const schemaPath = process.env.SCHEMA_FILE;
  const redisUrl = process.env.REDIS_URL;
  if (!schemaPath) throw new Error("SCHEMA_FILE required");
  if (!redisUrl) throw new Error("REDIS_URL required");

  const schema = loadSchema(schemaPath);

  // ρ_curv = (ρ_delta)² per MAR21 §21.5(3). All three intra-bucket correlations
  // are declared as `kind: "constant"` in the schema; the type guard mirrors
  // bootstrap.ts so a future non-constant correlation surfaces a clear error.
  const girrRho = schema.correlations.girr_rho_kl;
  const equityRho = schema.correlations.equity_rho;
  const fxRho = schema.correlations.fx_rho;
  if (girrRho?.kind !== "constant") throw new Error("girr_rho_kl must be constant");
  if (equityRho?.kind !== "constant") throw new Error("equity_rho must be constant");
  if (fxRho?.kind !== "constant") throw new Error("fx_rho must be constant");

  const tenorNodes = schema.risk_classes.GIRR?.tenor?.nodes ?? [];
  if (tenorNodes.length === 0) throw new Error("GIRR.tenor.nodes required");

  const dvSnippets = buildFrtbSnippets(schema);
  const curvSnippets: FrtbLibrarySnippet[] = [
    buildGirrCurvatureSnippet({
      tenors: tenorNodes.length,
      rho: girrRho.value * girrRho.value,
    }),
    buildEquityCurvatureSnippet({ rho: equityRho.value * equityRho.value }),
    buildFxCurvatureSnippet({ rho: fxRho.value * fxRho.value }),
  ];
  const all = [...dvSnippets, ...curvSnippets];

  const client = createClient(redisUrl);
  const nodes = resolveMasterNodes(client);
  for (const node of nodes) {
    await loadFrtbLibrary(node, all);
  }
  console.log(JSON.stringify({
    loaded: all.map((s) => s.name),
    nodes: nodes.length,
  }, null, 2));
  await client.quit().catch(() => undefined);
}

function createClient(url: string): Redis | Cluster {
  if (url.startsWith("redis-cluster://")) {
    return new Cluster([url.replace("redis-cluster://", "redis://")]);
  }
  return createRedisClient({ url });
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
