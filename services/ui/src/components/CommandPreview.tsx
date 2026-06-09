import { useCallback, useState, type ReactNode } from "react";

// Wave 5.96K: collapsible preview for long resolved Redis command strings
// (FT.AGGREGATE with APPLY chains, FCALL arg_template, etc.). Renders a
// single-line truncated preview by default and expands into the full <pre>
// on user toggle. Mirrors the native <details>/<summary> accessibility
// pattern already used for the "Dispatched keys" disclosure.
export interface CommandPreviewProps {
  command: string;
  // Test id placed on the inner <code> element containing the full command.
  // Preserving the existing testid keeps current UI tests passing.
  codeTestId?: string;
  // Optional test id placed on the inner <pre> element (also containing
  // the full command in its textContent).
  preTestId?: string;
  // Extra className applied to the inner <pre> for site-specific styling
  // (e.g. the BucketKbDrilldown command block).
  preClassName?: string;
  // Maximum characters shown in the collapsed preview before the ellipsis.
  previewLength?: number;
  // Optional caption rendered beneath the expanded command (used by the
  // existing CommandsPanel "Counts how many sensitivities…" copy).
  caption?: ReactNode;
}

const DEFAULT_PREVIEW_LENGTH = 120;

export function CommandPreview({
  command,
  codeTestId,
  preTestId,
  preClassName,
  previewLength = DEFAULT_PREVIEW_LENGTH,
  caption,
}: CommandPreviewProps) {
  const [copied, setCopied] = useState(false);
  const oneLine = command.replace(/\s+/g, " ").trim();
  const truncated = oneLine.length > previewLength;
  const preview = truncated ? `${oneLine.slice(0, previewLength)}…` : oneLine;

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable in test/insecure contexts; swallow.
    }
  }, [command]);

  const preClass = preClassName
    ? `command-preview__pre ${preClassName}`
    : "command-preview__pre";

  return (
    <details className="command-preview" data-testid="command-preview">
      <summary
        className="command-preview__summary"
        data-testid="command-preview-toggle"
      >
        <span className="command-preview__chevron" aria-hidden="true" />
        <code className="command-preview__preview">{preview}</code>
      </summary>
      <div className="command-preview__expanded">
        <pre className={preClass} data-testid={preTestId}>
          <code data-testid={codeTestId}>{command}</code>
        </pre>
        <button
          type="button"
          className="command-preview__copy"
          data-testid="command-preview-copy"
          onClick={onCopy}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        {caption}
      </div>
    </details>
  );
}
