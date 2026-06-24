import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { CalcRunProvider } from "./context/CalcRunContext";
import { BulkIngestRunProvider } from "./context/BulkIngestRunContext";
import { GeneratorRunProvider } from "./context/GeneratorRunContext";
import { PivotBurstProvider } from "./context/PivotBurstContext";
import { PivotHistoryProvider } from "./context/PivotHistoryContext";
import { UploadsProvider } from "./context/UploadsContext";
import { Connections } from "./routes/Connections";
import { Sources } from "./routes/Sources";
import { Ingest } from "./routes/Ingest";
import { Pivot } from "./routes/Pivot";
import { Calc } from "./routes/Calc";
import { Observability } from "./routes/Observability";
import { Shards } from "./routes/Shards";
import { Loadgen } from "./routes/Loadgen";
import { Explorer } from "./routes/Explorer";
import { Admin } from "./routes/Admin";

export function App() {
  return (
    <PivotBurstProvider>
      <GeneratorRunProvider>
        <CalcRunProvider>
        <BulkIngestRunProvider>
        <PivotHistoryProvider>
          <UploadsProvider>
            <AppShell>
              <Routes>
                <Route path="/" element={<Navigate to="/observability" replace />} />
                <Route path="/connections" element={<Connections />} />
                <Route path="/sources" element={<Sources />} />
                <Route path="/ingest" element={<Ingest />} />
                <Route path="/pivot" element={<Pivot />} />
                <Route path="/calc" element={<Calc />} />
                <Route path="/observability" element={<Observability />} />
                <Route path="/observability/shards" element={<Shards />} />
                <Route path="/loadgen" element={<Loadgen />} />
                <Route path="/explorer" element={<Explorer />} />
                <Route path="/admin" element={<Admin />} />
              </Routes>
            </AppShell>
          </UploadsProvider>
        </PivotHistoryProvider>
        </BulkIngestRunProvider>
        </CalcRunProvider>
      </GeneratorRunProvider>
    </PivotBurstProvider>
  );
}
