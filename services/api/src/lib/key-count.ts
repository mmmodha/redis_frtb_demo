import { resolveMasterNodes, type RedisLike } from "../bootstrap.ts";

const SCAN_COUNT = 10_000;

/** Count Redis keys matching a SCAN pattern (cluster-safe: sums all masters). */
export async function countKeysMatching(
  client: RedisLike,
  pattern: string,
  onPartial?: (count: number) => void,
): Promise<number> {
  const nodes = resolveMasterNodes(client);
  let total = 0;
  for (const node of nodes) {
    let cursor: string = "0";
    do {
      const [next, keys] = await node.scan(cursor, "MATCH", pattern, "COUNT", String(SCAN_COUNT));
      cursor = String(next);
      total += keys.length;
      onPartial?.(total);
    } while (cursor !== "0");
  }
  return total;
}
