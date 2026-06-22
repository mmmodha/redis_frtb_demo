export interface RladminShardRow {
  shard_id: string;
  role: "master" | "slave";
  memory_used: number;
  node_id?: string;
  key_count?: number;
}

export declare function parseRladminMemory(s: string): number;
export declare function parseRladminShards(text: string): RladminShardRow[];
