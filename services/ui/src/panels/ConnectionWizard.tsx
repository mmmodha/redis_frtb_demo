import { useMemo, useState } from "react";
import {
  CONNECTION_PRESETS,
  draftToConnectionInput,
  parseRedisUri,
  presetDefaults,
  type ConnectionPresetId,
} from "../lib/connectionPresets";
import {
  probeConnection,
  type ConnectionInput,
  type ConnectionTestResult,
} from "../lib/connections";
import { ConnectionProbeResult } from "./ConnectionProbeResult";

const STEPS = ["Profile", "Endpoint", "Security", "Test & save"] as const;

export interface ConnectionWizardProps {
  onCancel: () => void;
  onSubmit: (input: ConnectionInput) => void | Promise<void>;
  bannerError?: string | null;
  onSwitchToEdit?: (() => void) | null;
}

export function ConnectionWizard({
  onCancel,
  onSubmit,
  bannerError,
  onSwitchToEdit,
}: ConnectionWizardProps) {
  const [step, setStep] = useState(0);
  const [preset, setPreset] = useState<ConnectionPresetId>("enterprise");
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(presetDefaults("enterprise").port));
  const [uriPaste, setUriPaste] = useState("");
  const [uriError, setUriError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tls, setTls] = useState(true);
  const [ca, setCa] = useState("");
  const [probe, setProbe] = useState<ConnectionTestResult | "pending" | null>(null);
  const [saveAnyway, setSaveAnyway] = useState(false);
  const [saving, setSaving] = useState(false);

  const hostPlaceholder = useMemo(
    () => CONNECTION_PRESETS.find((p) => p.id === preset)?.hostPlaceholder ?? "redis-1.lab",
    [preset],
  );

  function applyPreset(id: ConnectionPresetId) {
    setPreset(id);
    const d = presetDefaults(id);
    setPort(String(d.port));
    setTls(!!d.tls?.enabled);
  }

  function applyUriPaste() {
    const parsed = parseRedisUri(uriPaste);
    if (!parsed) {
      setUriError("Could not parse URI — use redis:// or rediss://");
      return;
    }
    setUriError(null);
    if (parsed.host) setHost(parsed.host);
    if (parsed.port != null) setPort(String(parsed.port));
    if (parsed.username) setUsername(parsed.username);
    if (parsed.password) setPassword(parsed.password);
    if (parsed.tls) setTls(!!parsed.tls.enabled);
    setProbe(null);
    setSaveAnyway(false);
  }

  function buildInput(): ConnectionInput {
    return draftToConnectionInput({ name, host, port, username, password, tls, ca });
  }

  function canAdvance(): boolean {
    if (step === 0) return name.trim().length > 0;
    if (step === 1) {
      const p = Number(port);
      return host.trim().length > 0 && Number.isFinite(p) && p >= 1 && p <= 65535;
    }
    return true;
  }

  async function onTest() {
    setProbe("pending");
    setSaveAnyway(false);
    try {
      const r = await probeConnection(buildInput());
      setProbe(r);
    } catch (e) {
      setProbe({
        ok: false,
        errors: [(e as Error).message],
        modules: [],
      });
    }
  }

  async function handleSave(force = false) {
    if (!force && probe !== null && probe !== "pending" && !probe.ok && !saveAnyway) {
      setSaveAnyway(true);
      return;
    }
    setSaving(true);
    try {
      await onSubmit(buildInput());
    } finally {
      setSaving(false);
    }
  }

  function onNext(e?: React.FormEvent) {
    e?.preventDefault();
    if (!canAdvance()) return;
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function onBack() {
    setStep((s) => Math.max(s - 1, 0));
  }

  const probeOk = probe !== null && probe !== "pending" && probe.ok;
  const canSave = probeOk || saveAnyway;

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <form
        className="dialog connection-wizard"
        role="dialog"
        aria-modal="true"
        aria-label="Add cluster"
        data-testid="connection-wizard"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (step < STEPS.length - 1) onNext();
          else void handleSave();
        }}
      >
        <header className="connection-wizard__head">
          <h2>Add cluster</h2>
          <ol className="connection-wizard__steps" aria-label="Wizard steps">
            {STEPS.map((label, i) => (
              <li
                key={label}
                className={`connection-wizard__step${i === step ? " is-active" : ""}${i < step ? " is-done" : ""}`}
                aria-current={i === step ? "step" : undefined}
                data-testid={`wizard-step-indicator-${i + 1}`}
              >
                <span className="connection-wizard__step-num">{i < step ? "✓" : i + 1}</span>
                <span className="connection-wizard__step-label">{label}</span>
              </li>
            ))}
          </ol>
        </header>

        {step === 0 ? (
          <div className="connection-wizard__panel" data-testid="wizard-step-1">
            <label>
              <span>Cluster name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
                placeholder="demo-cluster"
              />
            </label>
            <fieldset className="connection-wizard__presets">
              <legend>Deployment preset</legend>
              <div className="connection-wizard__preset-grid">
                {CONNECTION_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`connection-wizard__preset${preset === p.id ? " is-selected" : ""}`}
                    data-testid={`preset-${p.id}`}
                    aria-pressed={preset === p.id}
                    onClick={() => applyPreset(p.id)}
                  >
                    <strong>{p.label}</strong>
                    <span>{p.description}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="connection-wizard__panel" data-testid="wizard-step-2">
            <label>
              <span>Host</span>
              <input
                value={host}
                onChange={(e) => { setHost(e.target.value); setProbe(null); }}
                required
                autoFocus
                placeholder={hostPlaceholder}
              />
            </label>
            <label>
              <span>Port</span>
              <input
                type="number"
                value={port}
                onChange={(e) => { setPort(e.target.value); setProbe(null); }}
                required
                min={1}
                max={65535}
              />
            </label>
            {host.trim() ? (
              <p className="connection-wizard__preview">
                Endpoint preview: <code>{host.trim()}:{port}</code>
              </p>
            ) : null}
            <div className="connection-wizard__uri">
              <label>
                <span>Paste connection URI (optional)</span>
                <input
                  value={uriPaste}
                  onChange={(e) => setUriPaste(e.target.value)}
                  placeholder="rediss://user:pass@host:12000"
                />
              </label>
              <button type="button" className="btn" onClick={applyUriPaste} data-testid="wizard-apply-uri">
                Apply URI
              </button>
              {uriError ? <p className="connection-wizard__uri-error" role="alert">{uriError}</p> : null}
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="connection-wizard__panel" data-testid="wizard-step-3">
            <label>
              <span>Username</span>
              <input
                value={username}
                onChange={(e) => { setUsername(e.target.value); setProbe(null); }}
                placeholder="default"
                autoFocus
              />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setProbe(null); }}
                autoComplete="new-password"
              />
            </label>
            <label className="dialog__checkbox">
              <input
                type="checkbox"
                checked={tls}
                onChange={(e) => { setTls(e.target.checked); setProbe(null); }}
              />
              <span>TLS enabled</span>
            </label>
            {tls ? (
              <label>
                <span>CA certificate (PEM)</span>
                <textarea
                  value={ca}
                  onChange={(e) => { setCa(e.target.value); setProbe(null); }}
                  rows={3}
                  placeholder="-----BEGIN CERTIFICATE----- (optional — system trust when empty)"
                />
              </label>
            ) : null}
            <p className="connection-wizard__hint">
              ACL credentials and mutual TLS are verified on the next step.
            </p>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="connection-wizard__panel" data-testid="wizard-step-4">
            <p className="connection-wizard__summary">
              <strong>{name.trim() || "Unnamed"}</strong>
              {" · "}
              <code>{host.trim()}:{port}</code>
              {tls ? " · TLS" : ""}
            </p>
            <div className="connection-wizard__test-row">
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void onTest()}
                disabled={probe === "pending" || !canAdvance()}
                data-testid="wizard-test"
              >
                {probe === "pending" ? "Testing…" : "Test connection"}
              </button>
            </div>
            <ConnectionProbeResult result={probe} />
            {saveAnyway && probe !== null && probe !== "pending" && !probe.ok ? (
              <p className="connection-wizard__warn" role="alert">
                Last test failed. Click <strong>Save anyway</strong> to persist this profile without a successful probe.
              </p>
            ) : null}
          </div>
        ) : null}

        {bannerError ? (
          <div className="dialog__banner-error" role="alert" data-testid="dialog-banner-error">
            <span>{bannerError}</span>
            {onSwitchToEdit ? (
              <button type="button" className="btn" onClick={onSwitchToEdit} data-testid="dialog-switch-to-edit">
                Switch to Edit
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="dialog__actions connection-wizard__actions">
          <button type="button" onClick={onCancel} disabled={saving}>Cancel</button>
          {step > 0 ? (
            <button type="button" className="btn" onClick={onBack} disabled={saving} data-testid="wizard-back">
              Back
            </button>
          ) : null}
          {step < STEPS.length - 1 ? (
            <button
              type="submit"
              className="btn btn--primary"
              disabled={!canAdvance() || saving}
              data-testid="wizard-next"
            >
              Next
            </button>
          ) : (
            <>
              {!probeOk && probe !== null && probe !== "pending" && !saveAnyway ? (
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={saving}
                  onClick={() => void handleSave(false)}
                  data-testid="wizard-save-anyway"
                >
                  Save anyway
                </button>
              ) : null}
              <button
                type="submit"
                className="btn btn--primary"
                disabled={!canSave || saving || probe === "pending"}
                data-testid="wizard-save"
              >
                {saving ? "Saving…" : "Save cluster"}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
