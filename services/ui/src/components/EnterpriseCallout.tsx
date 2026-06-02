import type { ReactNode } from "react";

// Signal IDs map to entries in the "Why Redis Enterprise" business-value table
// in the spec. Stub component for Wave 3; Wave 4.5 wires it to signals.yaml.
export type EnterpriseSignal =
  | "JSON"
  | "Streams"
  | "RQE"
  | "RedisQueryEngine"
  | "Functions"
  | "ClusterScaleOut"
  | "AutoTiering"
  | "HA"
  | "ObservabilityModule"
  | "DeployInPerimeter"
  | "ModuleBundle"
  | "PerformancePerNode"
  | "Operator"
  | "ActiveActive"
  | "DataSovereignty";

export interface EnterpriseCalloutProps {
  signal: EnterpriseSignal;
  children?: ReactNode;
}

export function EnterpriseCallout({ signal, children }: EnterpriseCalloutProps) {
  return (
    <aside className="enterprise-callout" data-signal={signal}>
      <div>
        <div className="enterprise-callout__tag">💼 Business value</div>
        <div className="enterprise-callout__signal">{signal}</div>
        {children ? <div className="enterprise-callout__body">{children}</div> : null}
      </div>
    </aside>
  );
}
