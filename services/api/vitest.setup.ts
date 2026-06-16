// Wave 5.83C-1 — default the FT.AGGREGATE fast path OFF for the unit suite
// so the existing FCALL-stubbed tests (fakeRedis returns canned per-bucket
// {K_b,S_b,count,ms} maps) keep passing. Individual fast-path tests opt-in by
// flipping process.env.CALC_FAST_PATH back to "1" inside beforeEach +
// restoring in afterEach.
if (process.env.CALC_FAST_PATH === undefined) {
  process.env.CALC_FAST_PATH = "0";
}
// Wave 6.14b — default the rollup fast-fast path OFF for the unit suite so
// the existing FT.AGGREGATE-stub tests don't trip an unhandled HGETALL on
// the canned fakeRedis. Rollup tests opt-in by flipping the flag to "1"
// inside beforeEach + restoring in afterEach.
if (process.env.CALC_ROLLUP_PATH === undefined) {
  process.env.CALC_ROLLUP_PATH = "0";
}
