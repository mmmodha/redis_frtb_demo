import { render, type RenderResult } from "@testing-library/react";
import { CalcPanel } from "../../src/panels/CalcPanel";
import { CalcRunProvider, resetCalcRunInFlightForTests } from "../../src/context/CalcRunContext";
import { clearCalcRunStorage } from "../../src/lib/calcRunState";

export function renderCalcPanel(): RenderResult {
  clearCalcRunStorage();
  resetCalcRunInFlightForTests();
  return render(
    <CalcRunProvider>
      <CalcPanel />
    </CalcRunProvider>,
  );
}
