import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

// Wave 5.73e — shared spawn helper for calc integration tests. The locked
// `frtb` library requires Redis 7+ (FUNCTION LOAD); the Ubuntu 22.04 apt
// `redis-server` package is Redis 6.0 and lacks FUNCTION LOAD, so we must
// prefer the redis-stack stack. The apt `redis-stack-server` wrapper does
// not always load modules when spawned standalone with custom args, so the
// most reliable path on CI is to drive `redis-server` ourselves with the
// explicit `--loadmodule` flags pointing at the .so files the apt package
// installs under `/opt/redis-stack/lib/`.

function binaryOnPath(binary: string): boolean {
  const r = spawnSync("which", [binary], { stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0;
}

const STACK_LIB_DIR = "/opt/redis-stack/lib";
const STACK_MODULES = [
  `${STACK_LIB_DIR}/redisearch.so`,
  `${STACK_LIB_DIR}/rejson.so`,
];

function hasStackModulesOnDisk(): boolean {
  return STACK_MODULES.every((p) => existsSync(p));
}

function resolveStrategy(): { kind: "stack-inline" | "stack-bin" | "vanilla" | "none"; bin?: string } {
  const envBin = process.env.REDIS_STACK_BIN;
  if (envBin && binaryOnPath(envBin)) return { kind: "stack-bin", bin: envBin };
  // Prefer driving redis-server with explicit --loadmodule flags pointing at
  // the apt-installed .so files; this is the only configuration we have seen
  // reliably expose FT.* / JSON.* on the Ubuntu apt redis-stack-server pkg.
  if (binaryOnPath("redis-server") && hasStackModulesOnDisk()) {
    return { kind: "stack-inline", bin: "redis-server" };
  }
  if (binaryOnPath("redis-stack-server")) return { kind: "stack-bin", bin: "redis-stack-server" };
  if (binaryOnPath("redis-server")) return { kind: "vanilla", bin: "redis-server" };
  return { kind: "none" };
}

const STRATEGY = resolveStrategy();

export const RESOLVED_REDIS_BIN: string | undefined = STRATEGY.bin;
export const redisAvailable: boolean = STRATEGY.kind !== "none";

export function spawnRedis(port: number, dir: string): ChildProcess {
  const baseArgs = [
    "--port", String(port),
    "--dir", dir,
    "--save", "",
    "--appendonly", "no",
    "--protected-mode", "no",
  ];
  const moduleArgs = STRATEGY.kind === "stack-inline"
    ? STACK_MODULES.flatMap((m) => ["--loadmodule", m])
    : [];
  const p = spawn(STRATEGY.bin ?? "redis-server", [...baseArgs, ...moduleArgs], { stdio: "ignore" });
  p.on("error", () => undefined);
  return p;
}
