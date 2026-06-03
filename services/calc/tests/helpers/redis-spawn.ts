import { spawn, spawnSync, type ChildProcess } from "node:child_process";

// Wave 5.73e — shared spawn helper for calc integration tests. The locked
// `frtb` library requires Redis 7+ (FUNCTION LOAD); prefer redis-stack-server
// (Redis 7.4+ with modules) and fall back to redis-server. On Ubuntu 22.04
// the apt `redis-server` package is Redis 6.0 and lacks FUNCTION LOAD, which
// is why prefering redis-stack-server is required for green CI.

function binaryOnPath(binary: string): boolean {
  const r = spawnSync("which", [binary], { stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0;
}

function resolveBinary(): string | undefined {
  const envBin = process.env.REDIS_STACK_BIN;
  if (envBin && binaryOnPath(envBin)) return envBin;
  for (const bin of ["redis-stack-server", "redis-server"]) {
    if (binaryOnPath(bin)) return bin;
  }
  return undefined;
}

export const RESOLVED_REDIS_BIN: string | undefined = resolveBinary();
export const redisAvailable: boolean = RESOLVED_REDIS_BIN !== undefined;

export function spawnRedis(port: number, dir: string): ChildProcess {
  const bin = RESOLVED_REDIS_BIN ?? "redis-server";
  const p = spawn(
    bin,
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" },
  );
  p.on("error", () => undefined);
  return p;
}
