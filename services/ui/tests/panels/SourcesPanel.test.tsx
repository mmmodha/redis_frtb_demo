import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SourcesPanel } from "../../src/panels/SourcesPanel";
import { UploadsProvider } from "../../src/context/UploadsContext";
import { installFakeXHR } from "../helpers/fake-xhr";

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
vi.mock("../../src/components/EnterpriseCallout", () => ({
  EnterpriseCallout: ({ signal, children }: { signal: string; children?: React.ReactNode }) => (
    <aside data-testid="enterprise-callout" data-signal={signal}>
      <span>business value: {signal}</span>
      {children}
    </aside>
  ),
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeSource(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "src-1",
    name: "girr-100k.csv",
    format: "csv",
    origin: "upload",
    size_bytes: 12345,
    status: "uploaded",
    created_at: "2026-05-22T10:00:00Z",
    updated_at: "2026-05-22T10:00:00Z",
    ...over,
  };
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <UploadsProvider>
        <SourcesPanel />
      </UploadsProvider>
    </MemoryRouter>,
  );
}

describe("SourcesPanel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the Sources heading, drag-drop zone, and 3 EnterpriseCallout business-value banners", async () => {
    fetchMock.mockImplementation(async () => jsonResponse([]));
    renderPanel();
    expect(screen.getByRole("heading", { name: /^Sources$/i, level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId("sources-dropzone")).toBeInTheDocument();
    await waitFor(() => {
      const callouts = screen.getAllByTestId("enterprise-callout");
      const signals = callouts.map((c) => c.getAttribute("data-signal"));
      expect(signals).toEqual(expect.arrayContaining(["JSON", "Streams", "ObservabilityModule"]));
      expect(callouts.length).toBeGreaterThanOrEqual(3);
    });
  });

  it("shows the empty-state copy when GET /sources returns []", async () => {
    fetchMock.mockImplementation(async () => jsonResponse([]));
    renderPanel();
    await waitFor(() => expect(screen.getByText(/no sources yet/i)).toBeInTheDocument());
    expect(screen.getByText(/drop a CSV to begin/i)).toBeInTheDocument();
  });

  it("shows a loading indicator while GET /sources is in flight", () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    renderPanel();
    expect(screen.getByText(/loading sources/i)).toBeInTheDocument();
  });

  it("shows an error PanelCard with a retry button when GET /sources fails", async () => {
    fetchMock.mockImplementation(async () => new Response("boom", { status: 500 }));
    renderPanel();
    await waitFor(() => expect(screen.getByText(/failed to load sources/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("Wave 5.90 — 502 unreachable + no uploads → renders empty-state with offline hint", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ error: "source service unreachable" }, 502),
    );
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId("sources-empty-offline")).toBeInTheDocument(),
    );
    expect(screen.getByText(/no sources yet/i)).toBeInTheDocument();
    expect(screen.getByText(/source service is offline/i)).toBeInTheDocument();
    expect(screen.queryByText(/failed to load sources/i)).toBeNull();
  });

  it("Wave 5.90 — 502 unreachable + an upload entry → renders red error card", async () => {
    const harness = installFakeXHR();
    fetchMock.mockImplementation(async () =>
      jsonResponse({ error: "source service unreachable" }, 502),
    );
    renderPanel();
    const dz = await waitFor(() => screen.getByTestId("sources-dropzone"));
    const file = new File(["a,b\n1,2"], "drop.csv", { type: "text/csv" });
    const dt = { files: [file], items: [{ kind: "file", type: "text/csv", getAsFile: () => file }], types: ["Files"] } as unknown as DataTransfer;
    fireEvent.drop(dz, { dataTransfer: dt });
    await harness.waitForSend();
    await waitFor(() =>
      expect(screen.getByText(/failed to load sources/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByTestId("sources-empty-offline")).toBeNull();
  });

  it("renders one source-row per source with name, size, status pill, and per-row actions", async () => {
    const sources = [
      makeSource({ id: "src-1", name: "girr-100k.csv", size_bytes: 1024 * 1024, status: "mapped" }),
      makeSource({ id: "src-2", name: "equity-50k.csv", size_bytes: 512 * 1024, status: "uploaded" }),
    ];
    fetchMock.mockImplementation(async () => jsonResponse(sources));
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("source-row-src-1")).toBeInTheDocument());

    const row1 = screen.getByTestId("source-row-src-1");
    expect(within(row1).getByText("girr-100k.csv")).toBeInTheDocument();
    expect(within(row1).getByText(/1\.00 MB|1 MB/i)).toBeInTheDocument();
    const pill1 = within(row1).getByTestId("status-pill");
    expect(pill1.getAttribute("data-status")).toBe("mapped");
    expect(within(row1).getByRole("button", { name: /configure mapping/i })).toBeInTheDocument();
    expect(within(row1).getByRole("button", { name: /^ingest$/i })).toBeInTheDocument();
    expect(within(row1).getByRole("button", { name: /delete/i })).toBeInTheDocument();

    const row2 = screen.getByTestId("source-row-src-2");
    const ingestBtn = within(row2).getByRole("button", { name: /^ingest$/i });
    expect(ingestBtn).toBeDisabled();
  });

  it("Configure mapping → POST /sources/:id/infer → opens MappingWizard", async () => {
    const source = makeSource({ id: "src-1", status: "uploaded" });
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/sources") && method === "GET") return jsonResponse([source]);
      if (/\/sources\/src-1\/infer$/.test(url) && method === "POST") {
        return jsonResponse({
          source: { ...source, status: "inferred" },
          columns: [
            { name: "risk_class", detected_type: "TAG", sample_values: ["GIRR", "Equity"] },
            { name: "tenor_3m", detected_type: "NUMERIC", sample_values: ["0.1", "0.2"] },
          ],
          mapping_suggestion: { fields: { risk_class: { from: "risk_class" } } },
        });
      }
      return jsonResponse({});
    });
    renderPanel();
    const configureBtn = await waitFor(() => screen.getByRole("button", { name: /configure mapping/i }));
    fireEvent.click(configureBtn);
    const wizard = await waitFor(() => screen.getByTestId("mapping-wizard"));
    const colsList = within(wizard).getByTestId("mapping-wizard__columns");
    expect(within(colsList).getByText("risk_class")).toBeInTheDocument();
  });

  it("Save & Ingest from wizard → POST /mapping then POST /ingest then refreshes list", async () => {
    const source = makeSource({ id: "src-1", status: "uploaded" });
    const seen: string[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      seen.push(`${method} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
      if (url.endsWith("/sources") && method === "GET") return jsonResponse([source]);
      if (/\/sources\/src-1\/infer$/.test(url)) {
        return jsonResponse({
          source,
          columns: [{ name: "risk_class", detected_type: "TAG", sample_values: ["GIRR"] }],
          mapping_suggestion: { fields: { risk_class: { from: "risk_class" } } },
        });
      }
      if (/\/sources\/src-1\/mapping$/.test(url)) return jsonResponse({ ...source, status: "mapped" });
      if (/\/sources\/src-1\/ingest$/.test(url)) return jsonResponse({ ...source, status: "ingesting" });
      return jsonResponse({});
    });
    renderPanel();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: /configure mapping/i })));
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: /auto-suggest/i })));
    fireEvent.click(screen.getByRole("button", { name: /save & ingest/i }));
    await waitFor(() => {
      expect(seen.some((s) => /POST \/sources\/src-1\/mapping/.test(s))).toBe(true);
      expect(seen.some((s) => /POST \/sources\/src-1\/ingest/.test(s))).toBe(true);
    });
  });

  it("drag-drop onto the dropzone POSTs the file to /sources/upload (via XHR)", async () => {
    const harness = installFakeXHR();
    fetchMock.mockImplementation(async () => jsonResponse([]));
    renderPanel();
    const dz = await waitFor(() => screen.getByTestId("sources-dropzone"));
    const file = new File(["a,b\n1,2"], "drop.csv", { type: "text/csv" });
    const dt = { files: [file], items: [{ kind: "file", type: "text/csv", getAsFile: () => file }], types: ["Files"] } as unknown as DataTransfer;
    fireEvent.drop(dz, { dataTransfer: dt });
    const xhr = await harness.waitForSend();
    expect(xhr.url).toMatch(/\/sources\/upload$/);
    expect(xhr.method).toBe("POST");
    expect(xhr.sentBody).toBeInstanceOf(FormData);
    const sent = (xhr.sentBody as FormData).get("file");
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe("drop.csv");
    xhr.complete(201, JSON.stringify(makeSource({ id: "src-9", name: "drop.csv" })));
  });

  it("drag-drop shows an in-flight upload row with a progress bar and Cancel button", async () => {
    const harness = installFakeXHR();
    fetchMock.mockImplementation(async () => jsonResponse([]));
    renderPanel();
    const dz = await waitFor(() => screen.getByTestId("sources-dropzone"));
    const file = new File(["abcdefghij"], "slow.csv", { type: "text/csv" });
    const dt = { files: [file], items: [{ kind: "file", type: "text/csv", getAsFile: () => file }], types: ["Files"] } as unknown as DataTransfer;
    fireEvent.drop(dz, { dataTransfer: dt });
    const xhr = await harness.waitForSend();
    // The row should appear immediately with status=uploading.
    const list = await waitFor(() => screen.getByTestId("uploads-list"));
    expect(within(list).getByText(/slow\.csv/)).toBeInTheDocument();
    // Emit progress and confirm the <progress> element reflects it.
    xhr.emitProgress(5, 10);
    await waitFor(() => {
      const bars = list.querySelectorAll("progress");
      expect(bars[0]!.value).toBeGreaterThan(0);
    });
    // Cancel button is wired to xhr.abort().
    const cancelBtn = within(list).getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelBtn);
    await waitFor(() => {
      expect(within(list).getByTestId("upload-status-pill")).toHaveAttribute("data-status", "aborted");
    });
  });

  it("in-flight upload survives unmount → remount of SourcesPanel (cross-panel survival)", async () => {
    const harness = installFakeXHR();
    fetchMock.mockImplementation(async () => jsonResponse([]));
    // Provider lives ABOVE the panel — the panel can unmount/remount and the
    // upload state remains alive.
    const Panel = () => (
      <MemoryRouter>
        <SourcesPanel />
      </MemoryRouter>
    );
    const { rerender } = render(
      <UploadsProvider>
        <Panel />
      </UploadsProvider>,
    );
    const dz = await waitFor(() => screen.getByTestId("sources-dropzone"));
    const file = new File(["xxxxxxxxxx"], "survive.csv", { type: "text/csv" });
    const dt = { files: [file], items: [{ kind: "file", type: "text/csv", getAsFile: () => file }], types: ["Files"] } as unknown as DataTransfer;
    fireEvent.drop(dz, { dataTransfer: dt });
    const xhr = await harness.waitForSend();
    xhr.emitProgress(3, 10);
    await waitFor(() => expect(screen.getByText(/survive\.csv/)).toBeInTheDocument());

    // Swap the panel for a stand-in (simulates navigating to /calc).
    rerender(
      <UploadsProvider>
        <div data-testid="other-panel">other panel</div>
      </UploadsProvider>,
    );
    expect(screen.queryByTestId("sources-dropzone")).toBeNull();

    // More progress while panel is unmounted.
    xhr.emitProgress(7, 10);

    // Remount — the row must still be visible at its current progress (>0).
    rerender(
      <UploadsProvider>
        <Panel />
      </UploadsProvider>,
    );
    const list = await waitFor(() => screen.getByTestId("uploads-list"));
    expect(within(list).getByText(/survive\.csv/)).toBeInTheDocument();
    const bar = list.querySelector("progress")!;
    expect(bar.value).toBeGreaterThan(0);
  });
});
