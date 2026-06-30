// Wave 6.39.D — Admin route is the only surface in the UI that pulls from
// the Layer 4 admin endpoints (calc-coverage, drift-status, snapshots,
// stream-status, reconcile-bucket). Each widget owns its own
// fetch/polling cadence; this route just lays them out.

import { CalcCoverageCard } from "../components/CalcCoverageCard";
import { DriftStatusCard } from "../components/DriftStatusCard";
import { SnapshotsCard } from "../components/SnapshotsCard";
import { StreamStatusCard } from "../components/StreamStatusCard";
import { ReconcileBucketAction } from "../components/ReconcileBucketAction";
import { IngestCapacityTestCard } from "../components/IngestCapacityTestCard";

export function Admin() {
  return (
    <>
      <h1>Admin</h1>
      <div className="admin-grid">
        <IngestCapacityTestCard />
        <CalcCoverageCard />
        <DriftStatusCard />
        <SnapshotsCard />
        <StreamStatusCard />
        <ReconcileBucketAction />
      </div>
    </>
  );
}
