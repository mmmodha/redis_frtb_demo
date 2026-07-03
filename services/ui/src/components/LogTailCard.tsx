import { useCallback, useEffect, useState } from "react";
import { PanelCard } from "./PanelCard";
import { getLogTail, type LogLine } from "../lib/admin";

const POLL_MS = 3_000;
const TAIL = 200;

function lineClass(level: string): string {
  if (level === "error" || level === "fatal") return "log-tail__line--error";
  if (level === "warn") return "log-tail__line--warn";
  return "";
}

function formatLine(l: LogLine): string {
  const parts = [l.ts.replace("T", " ").slice(0, 19), l.level.toUpperCase(), l.msg];
  if (l.request_id) parts.push(`req=${l.request_id}`);
  if (l.status_code !== undefined) parts.push(`status=${l.status_code}`);
  return parts.join(" ");
}

export function LogTailCard(): JSX.Element {
  const [items, setItems] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const poll = useCallback(async () => {
    try {
      const res = await getLogTail(TAIL);
      setItems(res.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = () => { if (!cancelled) void poll(); };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [poll]);

  const onCopy = useCallback(async () => {
    const text = items.map(formatLine).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  }, [items]);

  return (
    <PanelCard
      title="API log tail"
      actions={items.length > 0 ? (
        <button type="button" className="btn btn--secondary" onClick={() => { void onCopy(); }} data-testid="log-tail-copy">
          {copied ? "Copied" : "Copy tail"}
        </button>
      ) : null}
    >
      <p className="admin-stub">
        In-process ring buffer of recent API log lines (4xx/5xx responses and pino output when
        logging is enabled). For full container logs:{" "}
        <code>docker compose logs api --tail=500</code>
      </p>
      {error ? <p className="admin-error" role="alert">{error}</p> : null}
      {items.length === 0 ? (
        <p className="admin-stub" data-testid="log-tail-empty">No log lines captured yet.</p>
      ) : (
        <pre className="log-tail-pre" data-testid="log-tail-pre">
          {items.map((l, i) => (
            <span key={`${l.ts}-${i}`} className={`log-tail__line ${lineClass(l.level)}`}>
              {formatLine(l)}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
    </PanelCard>
  );
}
