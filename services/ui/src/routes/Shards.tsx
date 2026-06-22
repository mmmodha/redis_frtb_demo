// Wave 7.0.4.B — dedicated route for the live per-shard panel.
import { PerShardPanel } from "../components/PerShardPanel";

export function Shards() {
  return (
    <>
      <header className="observability__header">
        <h1>Per-shard observability</h1>
      </header>
      <PerShardPanel />
    </>
  );
}
