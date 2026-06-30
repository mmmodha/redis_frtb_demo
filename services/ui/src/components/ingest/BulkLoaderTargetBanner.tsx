import type { HostInfo } from "../../lib/ingest";

export function isBulkLoaderTargetDivergent(
  hostInfo: HostInfo | null,
  ingestTargetLabel: string | null,
): boolean {
  if (!hostInfo) return false;
  const bound = hostInfo.bulk_loader_bound_target;
  if (!bound || !ingestTargetLabel) return false;
  if (hostInfo.bulk_loader_target_stale) return true;
  return bound.label !== ingestTargetLabel;
}

export function BulkLoaderTargetBanner(props: {
  hostInfo: HostInfo | null;
  ingestTargetLabel: string | null;
}): JSX.Element | null {
  const { hostInfo, ingestTargetLabel } = props;
  if (!isBulkLoaderTargetDivergent(hostInfo, ingestTargetLabel)) return null;
  const bound = hostInfo!.bulk_loader_bound_target!;
  const stale = hostInfo!.bulk_loader_target_stale === true;
  const watcherEnabled = hostInfo!.bulk_loader_target_watcher === "enabled";
  const detail = stale
    ? watcherEnabled
      ? `Bulk-loader is still writing to ${bound.label} but the API active target is ${ingestTargetLabel}. ` +
        "The watcher should re-bind shortly; if this persists >30s, restart the bulk-loader process manually."
      : "Watcher is disabled (INTERNAL_API_TOKEN unset); the bulk-loader will not " +
        `auto-follow target switches. Bulk-loader is bound to ${bound.label} while the API target is ${ingestTargetLabel}. ` +
        "Restart the bulk-loader process or set INTERNAL_API_TOKEN to enable the active-target watcher."
    : watcherEnabled
      ? `Bulk-loader is bound to ${bound.label} but the API active target is ${ingestTargetLabel}. ` +
        "The watcher should re-bind shortly; if this persists >30s, restart the bulk-loader process manually."
      : `Bulk-loader is bound to ${bound.label} but the API active target is ${ingestTargetLabel}. ` +
        `New ingest rows will still go to ${bound.label}. Restart the bulk-loader process to redirect.`;

  return (
    <div
      className={`bulk-loader-target-banner${stale ? " bulk-loader-target-banner--stale" : " bulk-loader-target-banner--diverged"}`}
      role="alert"
      data-testid="bulk-loader-target-banner"
      data-stale={stale ? "true" : "false"}
      data-watcher={hostInfo!.bulk_loader_target_watcher ?? "unknown"}
    >
      <strong>{stale ? "Bulk-loader target stale" : "Bulk-loader target diverged"}</strong>
      <p>{detail}</p>
    </div>
  );
}
