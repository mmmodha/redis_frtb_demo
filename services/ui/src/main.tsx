import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
// Wave 4.6 — global.css split into tokens + shell + per-panel sheets.
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/observability.css";
import "./styles/connections.css";
import "./styles/connections-wizard.css";
import "./styles/sources.css";
import "./styles/calc.css";
import "./styles/benchmark.css";
import "./styles/pivot.css";
import "./styles/ingest.css";
import "./styles/loadgen.css";
import "./styles/json-explorer.css";
import "./styles/responsive.css";
// Wave 5.96A — KaTeX bundled stylesheet for the per-bucket drilldown formula
// block. Imported once at the app root so every <InlineMath />/<BlockMath />
// usage downstream renders with the correct font metrics.
import "katex/dist/katex.min.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("missing #root element");
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
