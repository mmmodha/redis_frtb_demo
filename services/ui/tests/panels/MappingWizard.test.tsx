import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MappingWizard } from "../../src/panels/SourcesPanel/MappingWizard";
import type { InferredColumn, ColumnMapping } from "../../src/lib/sources";

vi.mock("../../src/components/PanelCard", () => ({
  PanelCard: ({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) => (
    <section data-testid="panel-card" data-title={title}>
      <header>
        <h2>{title}</h2>
        {actions}
      </header>
      <div>{children}</div>
    </section>
  ),
}));

const COLUMNS: InferredColumn[] = [
  { name: "risk_class", detected_type: "TAG", sample_values: ["GIRR", "Equity", "FX"] },
  { name: "bucket", detected_type: "TAG", sample_values: ["B1", "B2"] },
  { name: "tenor_3m", detected_type: "NUMERIC", sample_values: ["0.10", "0.12"] },
  { name: "tenor_1y", detected_type: "NUMERIC", sample_values: ["0.21", "0.22"] },
  { name: "weight_pct", detected_type: "NUMERIC", sample_values: ["1.0", "0.8"] },
  { name: "notes_free", detected_type: "TEXT", sample_values: ["foo bar baz"] },
];

describe("MappingWizard", () => {
  let onSaveAndIngest: ReturnType<typeof vi.fn>;
  let onCancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSaveAndIngest = vi.fn();
    onCancel = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderWizard(suggestion?: ColumnMapping) {
    return render(
      <MappingWizard
        sourceId="src-1"
        sourceName="girr-100k.csv"
        columns={COLUMNS}
        suggestion={suggestion}
        onSaveAndIngest={onSaveAndIngest}
        onCancel={onCancel}
      />,
    );
  }

  it("renders all detected columns on the left with type + first 3 samples", () => {
    renderWizard();
    const colsList = screen.getByTestId("mapping-wizard__columns");
    for (const c of COLUMNS) {
      const row = within(colsList).getByTestId(`column-${c.name}`);
      expect(within(row).getByText(c.name)).toBeInTheDocument();
      expect(within(row).getByText(new RegExp(c.detected_type, "i"))).toBeInTheDocument();
      for (const s of c.sample_values.slice(0, 3)) {
        expect(within(row).getByText(s)).toBeInTheDocument();
      }
    }
  });

  it("renders the 6 FRTB binding dimensions on the right", () => {
    renderWizard();
    const dimsList = screen.getByTestId("mapping-wizard__dims");
    for (const dim of ["risk_class", "bucket", "tenor", "risk_value", "weight", "sensitivity_type"]) {
      expect(within(dimsList).getByTestId(`dim-${dim}`)).toBeInTheDocument();
    }
  });

  it("each dimension exposes a select-control listing every detected column + (unmapped)", () => {
    renderWizard();
    const select = screen.getByLabelText(/^risk_class$/i) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain("");
    for (const c of COLUMNS) expect(options).toContain(c.name);
  });

  it("Auto-suggest fills each select with the suggested mapping (single-column 'from')", () => {
    renderWizard({
      fields: {
        risk_class: { from: "risk_class" },
        bucket: { from: "bucket" },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /auto-suggest/i }));
    expect((screen.getByLabelText(/^risk_class$/i) as HTMLSelectElement).value).toBe("risk_class");
    expect((screen.getByLabelText(/^bucket$/i) as HTMLSelectElement).value).toBe("bucket");
  });

  it("Auto-suggest pre-selects array-element columns for risk_value (tenor multi-select)", () => {
    renderWizard({
      fields: { risk_value: { from: ["tenor_3m", "tenor_1y"], type: "array_number" } },
    });
    fireEvent.click(screen.getByRole("button", { name: /auto-suggest/i }));
    const arrayList = screen.getByTestId("dim-risk_value");
    expect(within(arrayList).getByText("tenor_3m")).toBeInTheDocument();
    expect(within(arrayList).getByText("tenor_1y")).toBeInTheDocument();
  });

  it("clicking a column row toggles its membership in the risk_value array", () => {
    renderWizard();
    fireEvent.click(screen.getByTestId("column-tenor_3m"));
    fireEvent.click(screen.getByTestId("column-tenor_1y"));
    const arrayList = screen.getByTestId("dim-risk_value");
    expect(within(arrayList).getByText("tenor_3m")).toBeInTheDocument();
    expect(within(arrayList).getByText("tenor_1y")).toBeInTheDocument();
  });

  it("Save & Ingest fires onSaveAndIngest with a normalised ColumnMapping ({ fields })", () => {
    renderWizard({
      fields: {
        risk_class: { from: "risk_class" },
        bucket: { from: "bucket" },
        risk_value: { from: ["tenor_3m", "tenor_1y"], type: "array_number" },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /auto-suggest/i }));
    fireEvent.click(screen.getByRole("button", { name: /save & ingest/i }));
    expect(onSaveAndIngest).toHaveBeenCalledTimes(1);
    const arg = onSaveAndIngest.mock.calls[0]![0] as ColumnMapping;
    expect(arg.fields.risk_class).toEqual({ from: "risk_class" });
    expect(arg.fields.bucket).toEqual({ from: "bucket" });
    expect(arg.fields.risk_value).toEqual({ from: ["tenor_3m", "tenor_1y"], type: "array_number" });
  });

  it("Cancel button fires onCancel", () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
