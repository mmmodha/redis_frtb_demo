import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useState } from "react";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SuggestCombobox } from "../../src/components/SuggestCombobox";

function Harness({
  initial = "",
  debounceMs = 10,
  fuzzy,
}: { initial?: string; debounceMs?: number; fuzzy?: boolean }) {
  const [v, setV] = useState<string>(initial);
  return (
    <SuggestCombobox
      field="book"
      value={v}
      onChange={setV}
      debounceMs={debounceMs}
      label="Book"
      fuzzy={fuzzy}
    />
  );
}

function suggestOk(values: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      suggestions: values.map((value) => ({ value, score: 1 })),
      ms: 1.0,
    }),
  };
}

function suggest503() {
  return {
    ok: false,
    status: 503,
    json: async () => ({ error: "no-suggester-or-data", hint: "hint-text" }),
  };
}

describe("<SuggestCombobox />", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders an ARIA combobox with aria-expanded toggling closed initially", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: /book/i });
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("debounces input and fires a single /suggest call for a burst of keystrokes", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(suggestOk(["R100", "R101"]));
    render(<Harness debounceMs={50} />);
    const input = screen.getByRole("combobox", { name: /book/i });
    // type 5 chars in rapid succession via React onChange
    fireEvent.change(input, { target: { value: "R" } });
    fireEvent.change(input, { target: { value: "R1" } });
    fireEvent.change(input, { target: { value: "R10" } });
    fireEvent.change(input, { target: { value: "R100" } });
    fireEvent.change(input, { target: { value: "R1000" } });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/suggest?");
    expect(url).toContain("field=book");
    expect(url).toContain("prefix=R1000");
    expect(url).toContain("fuzzy=1");
    vi.useRealTimers();
  });

  it("does not call fetch when prefix becomes empty", async () => {
    fetchMock.mockResolvedValue(suggestOk(["A"]));
    render(<Harness initial="A" />);
    const input = screen.getByRole("combobox", { name: /book/i });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "" } });
    // Wait past debounce window — no second fetch.
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opens the listbox and renders matching options after a successful fetch", async () => {
    fetchMock.mockResolvedValue(suggestOk(["RATES-LDN", "RATES-NYC"]));
    render(<Harness />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "R" } });
    const listbox = await screen.findByRole("listbox");
    const opts = await screen.findAllByRole("option");
    expect(opts).toHaveLength(2);
    expect(listbox).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "true");
    // first option is auto-active and exposed via aria-activedescendant
    expect(opts[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-activedescendant", opts[0]!.id);
  });

  it("ArrowDown advances the active option, Enter selects, closes and updates value", async () => {
    fetchMock.mockResolvedValue(suggestOk(["A1", "A2", "A3"]));
    render(<Harness />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "A" } });
    const opts = await screen.findAllByRole("option");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => expect(opts[1]).toHaveAttribute("aria-selected", "true"));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toBe("A2"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Escape closes the listbox without changing the input", async () => {
    fetchMock.mockResolvedValue(suggestOk(["B1"]));
    render(<Harness />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "B" } });
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.value).toBe("B");
  });

  it("Tab closes the listbox without selecting an option", async () => {
    fetchMock.mockResolvedValue(suggestOk(["C1", "C2"]));
    render(<Harness />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "C" } });
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.queryByRole("listbox")).toBeNull();
    // Value remains the raw prefix, not the auto-selected suggestion.
    expect(input.value).toBe("C");
  });

  it("renders the empty state for a non-empty prefix with zero matches", async () => {
    fetchMock.mockResolvedValue(suggestOk([]));
    render(<Harness />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Q" } });
    const list = await screen.findByRole("listbox");
    expect(list).toHaveTextContent(/no matches/i);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("renders the error state on a 5xx response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "boom" }) });
    render(<Harness />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Z" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/unavailable/i));
  });

  it("renders the error state on network failure", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    render(<Harness />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "X" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/unavailable/i));
  });

  it("503 from /suggest renders error state without throwing and logs a console.warn once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(suggest503());
    render(<Harness />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Y" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/unavailable/i));
    expect(warn).toHaveBeenCalledTimes(1);
    // A second prefix that also 503s must NOT log a second warning (one-shot).
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "YY" } });
    await new Promise((r) => setTimeout(r, 40));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("clicking an option selects it, closes the listbox and updates the input value", async () => {
    fetchMock.mockResolvedValue(suggestOk(["D1", "D2"]));
    render(<Harness />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "D" } });
    const opts = await screen.findAllByRole("option");
    fireEvent.mouseDown(opts[1]!);
    await waitFor(() => expect(input.value).toBe("D2"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("aborts a pending fetch when the prefix changes before it resolves", async () => {
    const abortReceived: AbortSignal[] = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal) abortReceived.push(init.signal);
      // Never resolves naturally — only via abort.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          (e as Error & { name: string }).name = "AbortError";
          reject(e);
        });
      });
    });
    render(<Harness debounceMs={10} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "P" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "PP" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // First signal must have been aborted.
    expect(abortReceived[0]!.aborted).toBe(true);
  });

  it("Wave 5.38d — fuzzy={false} forwards &fuzzy=0 in the /suggest URL", async () => {
    fetchMock.mockResolvedValue(suggestOk(["A1"]));
    render(<Harness fuzzy={false} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "A" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/suggest?");
    expect(url).toContain("fuzzy=0");
    expect(url).not.toContain("fuzzy=1");
  });
});

