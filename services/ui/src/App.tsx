import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Connections } from "./routes/Connections";
import { Sources } from "./routes/Sources";
import { Ingest } from "./routes/Ingest";
import { Pivot } from "./routes/Pivot";
import { Calc } from "./routes/Calc";
import { Observability } from "./routes/Observability";
import { Loadgen } from "./routes/Loadgen";
import { Explorer } from "./routes/Explorer";

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/observability" replace />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/sources" element={<Sources />} />
        <Route path="/ingest" element={<Ingest />} />
        <Route path="/pivot" element={<Pivot />} />
        <Route path="/calc" element={<Calc />} />
        <Route path="/observability" element={<Observability />} />
        <Route path="/loadgen" element={<Loadgen />} />
        <Route path="/explorer" element={<Explorer />} />
      </Routes>
    </AppShell>
  );
}
