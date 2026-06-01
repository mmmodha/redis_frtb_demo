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
