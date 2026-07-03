// Wave 6.39.D — Admin route is the only surface in the UI that pulls from
// the Layer 4 admin endpoints (calc-coverage, drift-status, snapshots,
// stream-status, reconcile-bucket). Each widget owns its own
// fetch/polling cadence; this route just lays them out.

import { CalcCoverageCard } from "../components/CalcCoverageCard";
import { DebugBundleCard } from "../components/DebugBundleCard";
import { ActiveCalcJobsCard } from "../components/ActiveCalcJobsCard";
import { RecentErrorsCard } from "../components/RecentErrorsCard";
import { LogTailCard } from "../components/LogTailCard";
import { DriftStatusCard } from "../components/DriftStatusCard";
import { SnapshotsCard } from "../components/SnapshotsCard";
import { StreamStatusCard } from "../components/StreamStatusCard";
import { ReconcileBucketAction } from "../components/ReconcileBucketAction";
import { IngestCapacityTestCard } from "../components/IngestCapacityTestCard";
import { Link } from "react-router-dom";

export function Admin() {
  return (
    <>
      <h1>Admin</h1>
      <div className="admin-grid">
        <DebugBundleCard />
        <ActiveCalcJobsCard />
        <RecentErrorsCard />
        <LogTailCard />
        <IngestCapacityTestCard />
        <CalcCoverageCard />
        <DriftStatusCard />
        <SnapshotsCard />
        <StreamStatusCard />
        <ReconcileBucketAction />
        <PanelCardLink
          title="Per-shard index lag"
          description="Requires the rladmin snapshot script. Shows index lag per Redis shard when a snapshot is loaded."
          to="/observability/shards"
          testId="admin-per-shard-link"
        />
      </div>
    </>
  );
}

function PanelCardLink(props: {
  title: string;
  description: string;
  to: string;
  testId: string;
}): JSX.Element {
  return (
    <section className="panel-card admin-link-card" data-testid={props.testId}>
      <h2 className="panel-card__title">{props.title}</h2>
      <p className="admin-link-card__desc">{props.description}</p>
      <Link to={props.to} className="btn btn--secondary">Open per-shard view</Link>
    </section>
  );
}
