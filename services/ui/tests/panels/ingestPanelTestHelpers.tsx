import type { ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BulkIngestRunProvider } from "../../src/context/BulkIngestRunContext";
import { IngestPanel } from "../../src/panels/IngestPanel";

export function renderIngestPanel(): RenderResult {
  return render(
    <BulkIngestRunProvider>
      <MemoryRouter>
        <IngestPanel />
      </MemoryRouter>
    </BulkIngestRunProvider>,
  );
}

export function renderIngestPanelOnly(children?: ReactNode): RenderResult {
  return render(
    <BulkIngestRunProvider>
      <MemoryRouter>
        {children ?? <IngestPanel />}
      </MemoryRouter>
    </BulkIngestRunProvider>,
  );
}
