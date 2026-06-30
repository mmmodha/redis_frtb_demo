import { describe, it, expect } from "vitest";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { countKeysMatching } from "../src/lib/key-count.ts";

describe("countKeysMatching", () => {
  it("counts all keys from a single SCAN cursor page", async () => {
    const fr = fakeRedis();
    fr.setScan("0", ["sens:a", "sens:b"]);
    await expect(countKeysMatching(fr, "sens:*")).resolves.toBe(2);
  });
});
