// Library entry point for @frtb/generator. The standalone CLI still lives in
// ./cli.ts (wired via package.json "bin"); this barrel exposes the same
// row-generation + Redis-stream-producer building blocks to in-process
// consumers (api → POST /generator/start).

export {
  createRowGenerator,
  type RowGenerator,
  type RowGeneratorOptions,
  type SensitivityRow,
} from "./row-generator.ts";

export {
  createStreamProducer,
  type StreamProducer,
  type StreamProducerOptions,
} from "./producer.ts";

// Wave 5.84C — cluster-adaptive profile / probe surfaces. Exposed so the
// api can build the same `plan` payload from its in-process redis client
// without duplicating the parser logic.
export {
  parseClusterInfo,
  parseInfoMemory,
  parseMaxclients,
  fallbackShape,
  probeCluster,
  BYTES_PER_ROW,
  type ClusterShape,
} from "./probe.ts";

export {
  pickProfile,
  profileDials,
  resolveDials,
  refuseOrGo,
  estimateDurationSec,
  STREAM_SHARDS_CAP,
  type ProfileName,
  type ProfileDials,
  type ResolvedDials,
  type RefuseOrGoResult,
} from "./profile.ts";
