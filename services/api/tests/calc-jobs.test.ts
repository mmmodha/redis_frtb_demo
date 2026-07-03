import { describe, it, expect, afterEach } from "vitest";
import {
  __resetCalcJobsForTests,
  finishCalcJob,
  listActiveCalcJobs,
  startCalcJob,
  updateCalcJob,
} from "../src/calc/calc-jobs.ts";

describe("calc-jobs registry", () => {
  afterEach(() => {
    __resetCalcJobsForTests();
  });

  it("tracks progress and evicts terminal jobs after grace", async () => {
    const job = startCalcJob({ kind: "total", cells_total: 27, request_id: "r1" });
    updateCalcJob(job.id, { cells_done: 5, current_cell: "GIRR delta low" });
    expect(listActiveCalcJobs()[0]?.cells_done).toBe(5);
    finishCalcJob(job.id, { status: "done" });
    expect(listActiveCalcJobs()[0]?.status).toBe("done");
  });
});
