// Wave 6.39.D — ReconcileBucketAction is the only POST in the admin UI.
// It POSTs /admin/reconcile-bucket with the admin token in the header and
// gates the call behind a type-back confirmation modal because the call
// re-derives a bucket's rollup sum from the underlying sensitivities.

import { useEffect, useState } from "react";
import { PanelCard } from "./PanelCard";
import {
  postReconcileBucket,
  loadAdminToken,
  saveAdminToken,
  type DriftSensitivity,
  type ReconcileBucketResponse,
} from "../lib/admin";

const SENS_TYPES: DriftSensitivity[] = ["Delta", "Vega", "Curvature"];
const CONFIRM_WORD = "RECONCILE";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: ReconcileBucketResponse }
  | { kind: "error"; message: string };

export function ReconcileBucketAction() {
  const [token, setToken] = useState<string>(() => loadAdminToken());
  const [riskClass, setRiskClass] = useState("");
  const [bucket, setBucket] = useState("");
  const [sensType, setSensType] = useState<DriftSensitivity>("Delta");
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  useEffect(() => { saveAdminToken(token); }, [token]);

  const canSubmit = token.trim().length > 0 && riskClass.trim().length > 0 && bucket.trim().length > 0;

  function openConfirm() {
    setConfirmText("");
    setShowConfirm(true);
    setState({ kind: "idle" });
  }
  function cancelConfirm() { setShowConfirm(false); setConfirmText(""); }

  async function doReconcile() {
    setShowConfirm(false);
    setConfirmText("");
    setState({ kind: "submitting" });
    try {
      const result = await postReconcileBucket({
        risk_class: riskClass.trim(),
        bucket: bucket.trim(),
        sensitivity_type: sensType,
        admin_token: token,
      });
      setState({ kind: "success", result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message });
    }
  }

  return (
    <PanelCard title="Reconcile Bucket">
      <div className="admin-form">
        <label>
          <span>Admin token</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            data-testid="reconcile-token"
            autoComplete="off"
            aria-label="Admin token"
          />
        </label>
        <label>
          <span>Risk class</span>
          <input
            type="text"
            value={riskClass}
            onChange={(e) => setRiskClass(e.target.value)}
            data-testid="reconcile-risk-class"
            placeholder="e.g. GIRR"
          />
        </label>
        <label>
          <span>Bucket</span>
          <input
            type="text"
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            data-testid="reconcile-bucket"
            placeholder="e.g. 1"
          />
        </label>
        <label>
          <span>Sensitivity type</span>
          <select
            value={sensType}
            onChange={(e) => setSensType(e.target.value as DriftSensitivity)}
            data-testid="reconcile-sens-type"
          >
            {SENS_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <div className="admin-form__actions">
          <button
            type="button"
            className="btn btn--danger"
            data-testid="reconcile-submit"
            disabled={!canSubmit || state.kind === "submitting"}
            onClick={openConfirm}
          >
            Reconcile bucket…
          </button>
        </div>
        {state.kind === "success" ? (
          <div className="admin-result" data-testid="reconcile-result" role="status">
            ✓ {state.result.risk_class} bucket {state.result.bucket} {state.result.sensitivity_type}
            — before <strong>{state.result.before_sum.toLocaleString("en-US")}</strong>,
            after <strong>{state.result.after_sum.toLocaleString("en-US")}</strong>,
            drift <strong>{(state.result.drift_pct * 100).toFixed(2)}%</strong>
          </div>
        ) : null}
        {state.kind === "error" ? (
          <div className="admin-error" role="alert">Reconcile failed — {state.message}</div>
        ) : null}
      </div>
      {showConfirm ? (
        <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Reconcile bucket confirmation">
          <div className="dialog" data-testid="reconcile-confirm-modal">
            <h2>Reconcile {riskClass} bucket {bucket} ({sensType})?</h2>
            <div>
              This re-derives the rollup sum from the underlying sensitivities and
              overwrites the cached value. Type <code>{CONFIRM_WORD}</code> to confirm.
            </div>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              data-testid="reconcile-confirm-input"
              aria-label="Type RECONCILE to confirm"
            />
            <div className="dialog__actions">
              <button type="button" className="btn" onClick={cancelConfirm} data-testid="reconcile-cancel">Cancel</button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={doReconcile}
                data-testid="reconcile-confirm"
                disabled={confirmText !== CONFIRM_WORD}
              >
                Reconcile
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </PanelCard>
  );
}
