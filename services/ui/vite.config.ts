import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Wave 6.05 — match the production UI server's same-origin /api proxy so
// `npm run dev` and `npm run preview` route browser → /api/* → API:8080
// without needing VITE_API_BASE.
const API_PORT = Number(process.env.API_PORT ?? 8080);
const apiProxy = {
  "/api": {
    target: `http://localhost:${API_PORT}`,
    changeOrigin: true,
    ws: false,
    rewrite: (p: string) => p.replace(/^\/api/, ""),
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: apiProxy,
  },
  preview: {
    port: 5173,
    host: "0.0.0.0",
    proxy: apiProxy,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    css: false,
  },
});
