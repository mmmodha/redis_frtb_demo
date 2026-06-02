import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EnterpriseCallout } from "../../src/components/EnterpriseCallout";

describe("<EnterpriseCallout />", () => {
  it("renders the signal name and a 'business value' marker", () => {
    render(<EnterpriseCallout signal="ObservabilityModule" />);
    expect(screen.getByText(/business value/i)).toBeInTheDocument();
    expect(screen.getByText(/ObservabilityModule/)).toBeInTheDocument();
  });

  it("renders children as supporting copy when provided", () => {
    render(
      <EnterpriseCallout signal="JSON">
        <span>Native JSON shape, no row explosion.</span>
      </EnterpriseCallout>,
    );
    expect(screen.getByText(/Native JSON shape/)).toBeInTheDocument();
  });
});
