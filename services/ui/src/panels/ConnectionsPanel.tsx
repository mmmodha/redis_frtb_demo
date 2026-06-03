// Wave 3.5A — Connections panel. CRUD + Test + Activate for Redis Enterprise
// cluster profiles. First panel the bank sees in the demo (step 2a).
//
// Surfaces three business-value callouts at the top (perimeter / module bundle
// / TLS+ACL), then a card per profile. Active profile gets a brand-red border
// and an "Active" badge — matches the redis-brand-ui status-language.

import { useCallback, useEffect, useMemo, useState } from "react";
import { EnterpriseCallout } from "../components/EnterpriseCallout";
import { PanelCard } from "../components/PanelCard";
import { useInflight } from "../hooks/useInflight";
import {
  activateConnection,
  createConnection,
  deleteConnection,
  DuplicateEndpointError,
  getActiveTarget,
  InflightConflictError,
  listConnections,
  testConnection,
  updateConnection,
  type ActiveTarget,
  type ConnectionInput,
  type ConnectionProfile,
  type ConnectionTestResult,
} from "../lib/connections";

const LOCKOUT_TITLE = "Cannot switch targets while runs are in flight";

type LoadState = "loading" | "data" | "error";
type DialogMode = { kind: "closed" } | { kind: "add" } | { kind: "edit"; profile: ConnectionProfile };

function emptyInput(): ConnectionInput {
  return { name: "", host: "", port: 12000, username: "", password: "", tls: { enabled: true } };
}

function inputFromProfile(p: ConnectionProfile): ConnectionInput {
  return {
    name: p.name, host: p.host, port: p.port,
    username: p.username ?? "",
    password: "", // server never returns it; user types a new one to change.
    tls: p.tls ? { enabled: !!p.tls.enabled } : { enabled: false },
    db: p.db,
  };
}

function isActiveProfile(p: ConnectionProfile, target: ActiveTarget | null): boolean {
  if (!target) return false;
  if (target.label && target.label === p.name) return true;
  return target.host === p.host && target.port === p.port;
}

function isReachable(tr: ConnectionTestResult | "pending" | undefined): boolean {
  return !!tr && tr !== "pending" && tr.ok === true;
}

function isConfirmedUnreachable(tr: ConnectionTestResult | "pending" | undefined): boolean {
  return !!tr && tr !== "pending" && tr.ok === false;
}

export function ConnectionsPanel() {
  const [state, setState] = useState<LoadState>("loading");
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [target, setTarget] = useState<ActiveTarget | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogMode>({ kind: "closed" });
  const [testResults, setTestResults] = useState<Record<string, ConnectionTestResult | "pending">>({});
  const [actionBusy, setActionBusy] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string | null>>({});
  // Wave 5.60 — inline duplicate-endpoint banner inside the dialog. Carries
  // the existing profile's id so the "Switch to Edit" button can reopen the
  // dialog on it. Cleared on every dialog open / mode switch.
  const [dialogBanner, setDialogBanner] = useState<{ message: string; existingId: string | null } | null>(null);
  const inflight = useInflight();
  const lockedOut = inflight.count > 0;

  const refresh = useCallback(async (opts?: { autoTest?: boolean }) => {
    setState("loading");
    setErrorMsg(null);
    try {
      const [t, ps] = await Promise.all([
        getActiveTarget().catch(() => null),
        listConnections(),
      ]);
      setTarget(t);
      setProfiles(ps);
      setState("data");
      if (opts?.autoTest && ps.length > 0) {
        setTestResults((s) => {
          const next = { ...s };
          for (const p of ps) next[p.id] = "pending";
          return next;
        });
        void Promise.allSettled(
          ps.map((p) =>
            testConnection(p.id).then(
              (r) => setTestResults((s) => ({ ...s, [p.id]: r })),
              (reason) =>
                setTestResults((s) => ({
                  ...s,
                  [p.id]: {
                    ok: false,
                    errors: [(reason as Error)?.message ?? String(reason)],
                    modules: [],
                  },
                })),
            ),
          ),
        );
      }
    } catch (e) {
      setErrorMsg(`Failed to load connections: ${(e as Error).message}`);
      setState("error");
    }
  }, []);

  useEffect(() => { void refresh({ autoTest: true }); }, [refresh]);

  const sortedProfiles = useMemo(() => {
    const rank = (p: ConnectionProfile): number => {
      const tr = testResults[p.id];
      if (isReachable(tr)) return 0;
      if (tr === undefined || tr === "pending") return 1;
      return 2;
    };
    return [...profiles].sort((a, b) => {
      const dr = rank(a) - rank(b);
      if (dr !== 0) return dr;
      return a.name.localeCompare(b.name);
    });
  }, [profiles, testResults]);

  // Wave 5.60 — derive POST vs PUT from an explicit `mode` parameter instead
  // of reading `dialog.kind` from the closure. The parent's `dialog` state is
  // consulted only to pick up the edit target's id and to drive the post-save
  // active-target dispatch when the edit hits the active profile.
  async function onSubmitDialog(mode: "add" | "edit", input: ConnectionInput) {
    try {
      if (mode === "add") {
        await createConnection(input);
      } else {
        // mode === "edit" — dialog.kind MUST be "edit" here by construction
        // (the dialog only renders when dialog.kind !== "closed" and the mode
        // it receives is derived from dialog.kind).
        if (dialog.kind !== "edit") return;
        // Wave 5.59 — if the edited profile is the active one, notify the
        // shell so the ActiveTargetPill re-fetches. The api already pushes
        // the new values into the active-target singleton on PUT.
        const wasActive = isActiveProfile(dialog.profile, target);
        await updateConnection(dialog.profile.id, input);
        if (wasActive) {
          window.dispatchEvent(new CustomEvent("connections:active-changed"));
        }
      }
      setDialog({ kind: "closed" });
      setDialogBanner(null);
      await refresh();
    } catch (e) {
      if (e instanceof DuplicateEndpointError) {
        // Keep the dialog open — render an inline banner with a Switch-to-Edit
        // affordance pointing at the existing profile.
        setDialogBanner({
          message: `A profile for ${e.host}:${e.port} already exists: ${e.existing_name}. Did you mean to edit it instead?`,
          existingId: e.existing_id,
        });
        return;
      }
      setErrorMsg(`Save failed: ${(e as Error).message}`);
    }
  }

  function onSwitchToEdit(existingId: string) {
    const existing = profiles.find((p) => p.id === existingId);
    setDialogBanner(null);
    if (!existing) {
      // Profile vanished (deleted concurrently) — just close the dialog.
      setDialog({ kind: "closed" });
      return;
    }
    setDialog({ kind: "edit", profile: existing });
  }

  async function onTest(id: string) {
    setTestResults((r) => ({ ...r, [id]: "pending" }));
    try {
      const r = await testConnection(id);
      setTestResults((s) => ({ ...s, [id]: r }));
    } catch (e) {
      setTestResults((s) => ({ ...s, [id]: { ok: false, errors: [(e as Error).message], modules: [] } }));
    }
  }

  async function onActivate(id: string) {
    setActionBusy((s) => ({ ...s, [id]: true }));
    setRowError((s) => ({ ...s, [id]: null }));
    try {
      await activateConnection(id);
      const t = await getActiveTarget().catch(() => null);
      setTarget(t);
      // Notify the shell so the ActiveTargetPill can re-fetch.
      window.dispatchEvent(new CustomEvent("connections:active-changed"));
    } catch (e) {
      if (e instanceof InflightConflictError) {
        const labels = e.inflight.map((it) => it.label).join(", ");
        const n = e.inflight.length;
        const msg = `Cannot activate: ${n} run${n === 1 ? "" : "s"} still in flight${labels ? ` (${labels})` : ""}`;
        setRowError((s) => ({ ...s, [id]: msg }));
      } else {
        setErrorMsg(`Activate failed: ${(e as Error).message}`);
      }
    } finally {
      setActionBusy((s) => ({ ...s, [id]: false }));
    }
  }

  async function onDelete(id: string) {
    setActionBusy((s) => ({ ...s, [id]: true }));
    try {
      await deleteConnection(id);
      await refresh();
    } catch (e) {
      setErrorMsg(`Delete failed: ${(e as Error).message}`);
    } finally {
      setActionBusy((s) => ({ ...s, [id]: false }));
    }
  }

  return (
    <div className="connections-panel">
      <header className="panel__header">
        <h1>Connections</h1>
        <p className="panel__subhead">
          Redis Enterprise cluster profiles — add, test modules + TLS + ACL, set the active target.
        </p>
      </header>

      <div className="connections-panel__callouts">
        <EnterpriseCallout signal="ClusterScaleOut">
          <strong>Deploy in your perimeter</strong> — bare-metal, VMware, GCP, AWS, OpenShift; the bank&rsquo;s VPC, the bank&rsquo;s NVMe, no SaaS dependency.
        </EnterpriseCallout>
        <EnterpriseCallout signal="ModuleBundle">
          <strong>Module bundle</strong> — JSON, Search, Time Series and Probabilistic ship inside Redis Enterprise / Stack; one Test click verifies them all.
        </EnterpriseCallout>
        <EnterpriseCallout signal="ObservabilityModule">
          <strong>TLS + ACL + data sovereignty</strong> — mutual-TLS, per-user ACLs and CA pinning are first-class on every profile.
        </EnterpriseCallout>
      </div>

      <PanelCard
        title="Cluster profiles"
        actions={
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => { setDialogBanner(null); setDialog({ kind: "add" }); }}
            data-testid="add-cluster-btn"
          >
            Add cluster
          </button>
        }
      >
        {state === "loading" ? (
          <div className="connections-panel__loading" role="status">
            <span className="spinner" aria-hidden="true" />
            <span>Loading clusters…</span>
          </div>
        ) : null}

        {state === "error" ? (
          <div className="connections-panel__error" role="alert">
            <p>{errorMsg ?? "Failed to load connections"}</p>
            <button type="button" onClick={() => void refresh()} className="btn">Retry</button>
          </div>
        ) : null}

        {state === "data" && sortedProfiles.length === 0 ? (
          <div className="connections-panel__empty">
            <p>
              <strong>No clusters configured yet</strong> — Add your first Redis Enterprise cluster to begin.
            </p>
            <button type="button" className="btn btn--primary" onClick={() => { setDialogBanner(null); setDialog({ kind: "add" }); }}>
              Add your first cluster
            </button>
          </div>
        ) : null}

        {state === "data" && sortedProfiles.length > 0 ? (
          <ul className="connections-panel__list">
            {sortedProfiles.map((p) => {
              const active = isActiveProfile(p, target);
              const tr = testResults[p.id];
              return (
                <li
                  key={p.id}
                  className={`profile-card${active ? " profile-card--active" : ""}`}
                  data-testid="profile-card"
                  data-active={active ? "true" : "false"}
                >
                  <div className="profile-card__head">
                    <div>
                      <h3>{p.name}</h3>
                      <code className="profile-card__addr">{p.host}:{p.port}</code>
                    </div>
                    <div className="profile-card__badges">
                      {p.tls?.enabled ? <span className="profile-card__tls" aria-label="TLS enabled">TLS</span> : null}
                      {active ? <span className="profile-card__active-badge">Active</span> : null}
                      <ProfileStatusPill result={tr} />
                    </div>
                  </div>

                  {tr && tr !== "pending" ? (
                    <div className="profile-card__test-result" data-testid={`test-result-${p.id}`}>
                      <span className={`pill pill--${tr.ok ? "ok" : "err"}`}>
                        {tr.ok ? "✓ reachable" : "✗ unreachable"}
                      </span>
                      {tr.latency_ms != null ? <span className="profile-card__latency">{tr.latency_ms} ms</span> : null}
                      <ul className="profile-card__modules">
                        {(tr.modules ?? []).map((m) => (
                          <li key={m.name} data-present={m.present ? "true" : "false"}>
                            {m.present ? "✓" : "✗"} {m.name}
                          </li>
                        ))}
                      </ul>
                      {tr.errors && tr.errors.length > 0 ? (
                        <p className="profile-card__test-error">{tr.errors.join("; ")}</p>
                      ) : null}
                    </div>
                  ) : null}

                  {!active && isConfirmedUnreachable(tr) ? (
                    <div
                      className="profile-card__warn"
                      role="alert"
                      data-testid={`activate-hint-${p.id}`}
                    >
                      <span className="profile-card__warn-icon" aria-hidden="true">⚠</span>
                      <span>Unreachable — fix connection to activate</span>
                    </div>
                  ) : null}

                  <div className="profile-card__actions">
                    <button type="button" onClick={() => void onTest(p.id)} disabled={tr === "pending"}>
                      {tr === "pending" ? "Testing…" : "Test"}
                    </button>
                    <button type="button" onClick={() => { setDialogBanner(null); setDialog({ kind: "edit", profile: p }); }}>
                      Edit
                    </button>
                    {!active && isConfirmedUnreachable(tr) ? null : (() => {
                      const unreachableReason = !active && !isReachable(tr)
                        ? (tr === "pending" ? "Testing connection…" : "Test the connection first")
                        : null;
                      const titleText = !active && lockedOut
                        ? LOCKOUT_TITLE
                        : unreachableReason;
                      const hintId = titleText ? `activate-hint-${p.id}` : undefined;
                      return (
                        <>
                          <button
                            type="button"
                            onClick={() => void onActivate(p.id)}
                            disabled={active || !!actionBusy[p.id] || !isReachable(tr) || (!active && lockedOut)}
                            className={active ? "" : "btn--primary"}
                            {...(titleText ? { title: titleText, "aria-describedby": hintId } : {})}
                          >
                            {active ? "Activated" : "Activate"}
                          </button>
                          {titleText ? (
                            <span id={hintId} className="visually-hidden">{titleText}</span>
                          ) : null}
                        </>
                      );
                    })()}
                    <button
                      type="button"
                      onClick={() => void onDelete(p.id)}
                      disabled={!!actionBusy[p.id]}
                      className="btn--danger"
                    >
                      Delete
                    </button>
                  </div>
                  {rowError[p.id] ? (
                    <p
                      className="profile-card__row-error"
                      role="alert"
                      data-testid={`activate-error-${p.id}`}
                    >
                      {rowError[p.id]}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </PanelCard>

      {dialog.kind !== "closed" ? (
        <ConnectionDialog
          // Wave 5.60 — `key` forces a remount when the dialog target changes
          // (e.g. Switch-to-Edit hops Add → Edit on a specific profile). The
          // form's internal useState would otherwise persist the prior values.
          key={dialog.kind === "edit" ? `edit-${dialog.profile.id}` : "add"}
          mode={dialog.kind}
          initial={dialog.kind === "edit" ? inputFromProfile(dialog.profile) : emptyInput()}
          onCancel={() => { setDialog({ kind: "closed" }); setDialogBanner(null); }}
          onSubmit={onSubmitDialog}
          bannerError={dialogBanner?.message ?? null}
          onSwitchToEdit={
            dialogBanner?.existingId
              ? () => onSwitchToEdit(dialogBanner.existingId!)
              : null
          }
        />
      ) : null}
    </div>
  );
}

function ProfileStatusPill({ result }: { result: ConnectionTestResult | "pending" | undefined }) {
  if (result === undefined) {
    return <span className="state-pill" data-status="untested"><span className="state-pill__dot" /> untested</span>;
  }
  if (result === "pending") {
    return <span className="state-pill" data-status="testing"><span className="state-pill__dot" data-state="loading" /> testing…</span>;
  }
  return (
    <span className="state-pill" data-status={result.ok ? "live" : "err"}>
      <span className="state-pill__dot" data-state={result.ok ? "ok" : "err"} />
      {result.ok ? "live" : "unreachable"}
    </span>
  );
}

function ConnectionDialog(props: {
  mode: "add" | "edit";
  initial: ConnectionInput;
  onCancel: () => void;
  // Wave 5.60 — submit receives the dialog's own mode as an explicit argument
  // so the parent's branch on POST vs PUT no longer depends on the captured
  // `dialog.kind` closure.
  onSubmit: (mode: "add" | "edit", input: ConnectionInput) => void | Promise<void>;
  bannerError?: string | null;
  onSwitchToEdit?: (() => void) | null;
}) {
  const { mode, initial, onCancel, onSubmit, bannerError, onSwitchToEdit } = props;
  const [name, setName] = useState(initial.name);
  const [host, setHost] = useState(initial.host);
  const [port, setPort] = useState(String(initial.port ?? ""));
  const [username, setUsername] = useState(initial.username ?? "");
  const [password, setPassword] = useState("");
  const [tls, setTls] = useState(!!initial.tls?.enabled);
  const [ca, setCa] = useState(initial.tls?.ca ?? "");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void onSubmit(mode, {
      name, host, port: Number(port),
      username: username || undefined,
      password: password || undefined,
      tls: { enabled: tls, ...(ca ? { ca } : {}) },
    });
  }

  const title = mode === "add" ? "Add cluster" : "Edit cluster";
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h2>{title}</h2>
        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label>
          <span>Host</span>
          <input value={host} onChange={(e) => setHost(e.target.value)} required placeholder="redis-1.lab" />
        </label>
        <label>
          <span>Port</span>
          <input type="number" value={port} onChange={(e) => setPort(e.target.value)} required min={1} max={65535} />
        </label>
        <label>
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="default" />
        </label>
        <label>
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "edit" ? "(unchanged)" : ""}
            autoComplete="new-password"
          />
        </label>
        <label className="dialog__checkbox">
          <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} />
          <span>TLS enabled</span>
        </label>
        {tls ? (
          <label>
            <span>CA certificate (PEM)</span>
            <textarea value={ca} onChange={(e) => setCa(e.target.value)} rows={3} placeholder="-----BEGIN CERTIFICATE-----" />
          </label>
        ) : null}
        {bannerError ? (
          <div
            className="dialog__banner-error"
            role="alert"
            data-testid="dialog-banner-error"
          >
            <span>{bannerError}</span>
            {onSwitchToEdit ? (
              <button
                type="button"
                className="btn"
                onClick={onSwitchToEdit}
                data-testid="dialog-switch-to-edit"
              >
                Switch to Edit
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="dialog__actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn--primary">Save</button>
        </div>
      </form>
    </div>
  );
}

export default ConnectionsPanel;
