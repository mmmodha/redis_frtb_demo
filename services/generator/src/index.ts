// Library entry point for @frtb/generator. The standalone CLI still lives in
// ./cli.ts (wired via package.json "bin"); this barrel exposes the same
// row-generation + Redis-stream-producer building blocks to in-process
// consumers (api → POST /generator/start).

export {
  createRowGenerator,
  type RowGenerator,
  type RowGeneratorOptions,
  type SensitivityRow,
  type DistributionMode,
} from "./row-generator.ts";

export {
  createStreamProducer,
  type StreamProducer,
  type StreamProducerOptions,
  type StreamProducerFlowControl,
} from "./producer.ts";

// Wave 7.0.6.13 — bulk-loader HTTP producer. Re-exported so the api's
// /ingest/bulk/start route can drive the bulk-loader fast path without
// duplicating batching/backpressure logic the CLI already owns.
export {
  createHttpProducer,
  toBulkRow,
  type HttpProducer,
  type HttpProducerOptions,
} from "./http-producer.ts";

// Wave 6.39.A — direct-write backend. Bypasses the Redis Stream and writes
// HSET + pre-aggregated HINCRBYFLOAT + SADD directly. Same `add/flush/close`
// surface as StreamProducer so the shared row-loop drives either backend.
export {
  createDirectWriter,
  type DirectWriter,
  type DirectWriterOptions,
  type DirectWriterHooks,
  type StorageFormat,
} from "./direct-writer.ts";

export {
  loadDirectWriterHooks,
  resolveStorageFormatEnv,
  resolveGeneratorMode,
  resolveDistribution,
  type GeneratorMode,
} from "./direct-writer-bind.ts";

// Wave 5.92C-fix — re-exported so the api route can construct the same
// producer-side XLEN credit gate the CLI uses (POST /generator/start{,/stream}
// previously bypassed the gate entirely). The flow-control module itself is
// unchanged.
export {
  createStreamFlowControl,
  DEFAULT_FLOW_CONTROL,
  type FlowControlOptions,
  type StreamFlowControl,
} from "./flow-control.ts";

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
