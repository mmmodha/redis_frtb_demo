import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CalcPanel } from "../../src/panels/CalcPanel";
import type { CalcSbmResponse } from "../../src/lib/calc";

const originalFetch = globalThis.fetch;

// Capture every /calc/sbm POST body so individual assertions can dissect them.
// Wave 6.41.D — filter out the /calc/sbm/by-desk fetches the new top-N panel
// fires after each calc lands so the capture list stays focused on the bodies
// these tests reason about.
function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}
function isCalcSbmCall(input: RequestInfo | URL): boolean {
  const u = urlOf(input);
  return u.includes("/calc/sbm") && !u.includes("/calc/sbm/by-desk");
}
function mockCalcWithCapture(body: CalcSbmResponse) {
  const sent: Array<unknown> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body && isCalcSbmCall(input)) {
      sent.push(JSON.parse(String(init.body)));
    }
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return sent;
}

const baseResponse: CalcSbmResponse = {
  charge: 1234567.89,
  per_bucket: [
    { bucket: "USD", K_b: 200, S_b: 180, count: 5000, ms: 12 },
    { bucket: "EUR", K_b: 100, S_b: 90, count: 2500, ms: 7 },
    { bucket: "GBP", K_b: 50, S_b: 45, count: 1000, ms: 5 },
  ],
  total_ms: 1500.4,
  shard_breakdown: [
    { shard: "shard-1", buckets: ["USD"], ms: 12 },
    { shard: "shard-2", buckets: ["EUR"], ms: 7 },
    { shard: "shard-3", buckets: ["GBP"], ms: 5 },
  ],
  fanout_ms: 14.6,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function firstRun(body: CalcSbmResponse = baseResponse) {
  const sent = mockCalcWithCapture(body);
  render(<CalcPanel />);
  fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
  await waitFor(() => expect(screen.getByTestId("calc-charge")).toBeInTheDocument());
  return sent;
}

describe("Wave 5.31a — Calc bucket-subset refine row", () => {
  it("does not render the Refine buckets row before the first /calc/sbm response", () => {
    render(<CalcPanel />);
    expect(screen.queryByTestId("refine-buckets")).toBeNull();
  });

  it("renders the Refine buckets row with one pill per bucket sorted by K_b descending", async () => {
    await firstRun();
    const row = await screen.findByTestId("refine-buckets");
    const pills = within(row).getAllByTestId("refine-bucket-pill");
    expect(pills.map((p) => p.getAttribute("data-bucket"))).toEqual(["USD", "EUR", "GBP"]);
    // All pills selected by default before any user interaction.
    for (const p of pills) {
      expect(p.getAttribute("data-selected")).toBe("true");
      expect(p.getAttribute("aria-pressed")).toBe("true");
    }
    expect(screen.getByTestId("refine-buckets-count").textContent).toBe("3/3 selected");
    // Reset link is only present once the user has touched the pills.
    expect(screen.queryByTestId("refine-buckets-reset")).toBeNull();
  });

  it("clicking a pill toggles its selection and updates the count badge", async () => {
    await firstRun();
    const usd = await screen.findByTestId("refine-buckets");
    const usdPill = within(usd).getAllByTestId("refine-bucket-pill").find(
      (p) => p.getAttribute("data-bucket") === "USD",
    )!;
    fireEvent.click(usdPill);
    await waitFor(() =>
      expect(screen.getByTestId("refine-buckets-count").textContent).toBe("2/3 selected"),
    );
    expect(usdPill.getAttribute("data-selected")).toBe("false");
    expect(usdPill.getAttribute("aria-pressed")).toBe("false");
    // Reset link appears as soon as we leave the default state.
    expect(screen.getByTestId("refine-buckets-reset")).toBeInTheDocument();
  });

  it("Calculate with all pills selected sends NO bucket_subset (identical to first-run body)", async () => {
    const sent = await firstRun();
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty("bucket_subset");
    // Trigger a second run without touching any pill.
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(sent.length).toBe(2));
    expect(sent[1]).toEqual({ risk_class: "GIRR", sensitivity_type: "Delta" });
    expect(sent[1]).not.toHaveProperty("bucket_subset");
  });

  it("Calculate with a 2-of-3 subset sends bucket_subset with exactly the selected buckets", async () => {
    const sent = await firstRun();
    const row = await screen.findByTestId("refine-buckets");
    const gbpPill = within(row).getAllByTestId("refine-bucket-pill").find(
      (p) => p.getAttribute("data-bucket") === "GBP",
    )!;
    fireEvent.click(gbpPill);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(sent.length).toBe(2));
    const body = sent[1] as { bucket_subset?: string[] };
    expect(body.bucket_subset).toBeDefined();
    expect(new Set(body.bucket_subset)).toEqual(new Set(["USD", "EUR"]));
  });

  it("Reset to all clears the subset back to all-selected and removes the link", async () => {
    await firstRun();
    const row = await screen.findByTestId("refine-buckets");
    const usdPill = within(row).getAllByTestId("refine-bucket-pill").find(
      (p) => p.getAttribute("data-bucket") === "USD",
    )!;
    fireEvent.click(usdPill);
    await waitFor(() =>
      expect(screen.getByTestId("refine-buckets-count").textContent).toBe("2/3 selected"),
    );
    fireEvent.click(screen.getByTestId("refine-buckets-reset"));
    await waitFor(() =>
      expect(screen.getByTestId("refine-buckets-count").textContent).toBe("3/3 selected"),
    );
    expect(screen.queryByTestId("refine-buckets-reset")).toBeNull();
  });

  it("disables Calculate when every pill has been deselected", async () => {
    await firstRun();
    const row = await screen.findByTestId("refine-buckets");
    const pills = within(row).getAllByTestId("refine-bucket-pill");
    for (const p of pills) fireEvent.click(p);
    await waitFor(() =>
      expect(screen.getByTestId("refine-buckets-count").textContent).toBe("0/3 selected"),
    );
    expect(screen.getByTestId("calc-cta")).toBeDisabled();
  });

  it("after a subset run completes, the prior selection is preserved (not reset to all)", async () => {
    const sent = await firstRun();
    const row = await screen.findByTestId("refine-buckets");
    const gbpPill = within(row).getAllByTestId("refine-bucket-pill").find(
      (p) => p.getAttribute("data-bucket") === "GBP",
    )!;
    fireEvent.click(gbpPill);
    // Second run with the subset narrowed to USD+EUR. Mock returns a 2-bucket
    // response to mirror what the api would do with the subset.
    const narrowed: CalcSbmResponse = {
      ...baseResponse,
      per_bucket: baseResponse.per_bucket.filter((b) => b.bucket !== "GBP"),
      shard_breakdown: baseResponse.shard_breakdown.filter((s) => s.shard !== "shard-3"),
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body && isCalcSbmCall(input)) {
        sent.push(JSON.parse(String(init.body)));
      }
      return new Response(JSON.stringify(narrowed), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(sent.length).toBe(2));
    // After the response lands, the pill row reflects the new (narrowed) bucket
    // list but the user's deselection of GBP is implicitly preserved by virtue
    // of GBP no longer being part of the response. Reset link must still be
    // visible — the subset state did not silently flip back to null.
    await waitFor(() => expect(screen.getByTestId("refine-buckets-count")).toBeInTheDocument());
    expect(screen.getByTestId("refine-buckets-reset")).toBeInTheDocument();
  });
});
