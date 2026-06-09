import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommandPreview } from "../../src/components/CommandPreview";

const LONG_CMD =
  "FT.AGGREGATE idx:sens \"@risk_class:{GIRR}\" GROUPBY 1 @bucket REDUCE COUNT 0 AS n LIMIT 0 10000 DIALECT 2 APPLY \"@n\" AS count APPLY \"@bucket\" AS b";

describe("<CommandPreview />", () => {
  it("renders collapsed by default (full <pre> not in the open <details>)", () => {
    render(<CommandPreview command={LONG_CMD} codeTestId="discovery-command" />);
    const details = screen.getByTestId("command-preview");
    expect(details.tagName.toLowerCase()).toBe("details");
    expect(details.hasAttribute("open")).toBe(false);
    // The toggle is the <summary> with a stable testid.
    const toggle = screen.getByTestId("command-preview-toggle");
    expect(toggle.tagName.toLowerCase()).toBe("summary");
    // Inner <code> with the preserved testid is in the DOM and contains the
    // full untruncated command text, so existing assertions keep working.
    expect(screen.getByTestId("discovery-command").textContent).toBe(LONG_CMD);
  });

  it("expands the full command when the toggle is clicked", () => {
    render(<CommandPreview command={LONG_CMD} codeTestId="discovery-command" />);
    const details = screen.getByTestId("command-preview");
    expect(details.hasAttribute("open")).toBe(false);
    fireEvent.click(screen.getByTestId("command-preview-toggle"));
    expect(details.hasAttribute("open")).toBe(true);
    expect(screen.getByTestId("discovery-command").textContent).toBe(LONG_CMD);
  });
});
