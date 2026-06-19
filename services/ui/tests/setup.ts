import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect } from "vitest";
import { cleanup } from "@testing-library/react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
expect.extend(matchers as any);

// Wave 6.45.B — Node 25's experimental built-in localStorage shadows the
// jsdom Storage with a stubbed object that has no setItem/getItem methods,
// so any code path that reads/writes localStorage throws under vitest. Swap
// in a minimal in-memory Storage on `window` and `globalThis` so tests can
// drive view-toggle persistence (and any other localStorage-backed prefs)
// deterministically.
function installLocalStorageShim(): void {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() { return store.size; },
    clear: () => { store.clear(); },
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => { store.delete(k); },
    setItem: (k, v) => { store.set(k, String(v)); },
  };
  try { Object.defineProperty(window, "localStorage", { value: shim, configurable: true, writable: true }); } catch { /* ignore */ }
  try { Object.defineProperty(globalThis, "localStorage", { value: shim, configurable: true, writable: true }); } catch { /* ignore */ }
}
if (typeof window !== "undefined" && typeof window.localStorage?.setItem !== "function") {
  installLocalStorageShim();
}

afterEach(() => {
  cleanup();
  try { window.localStorage.clear(); } catch { /* ignore */ }
});
