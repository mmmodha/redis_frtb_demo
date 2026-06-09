// Worker bootstrap shim — tsx's `--import tsx` auto-register is gated by
// `isMainThread`, so workers spawned with that flag never register the
// ESM loader and crash with ERR_UNKNOWN_FILE_EXTENSION on `.ts` files.
// Explicitly call tsx/esm/api's `register()` here, then dynamic-import
// the TypeScript worker entry.
import { register } from "tsx/esm/api";
register();
await import("./worker.ts");
