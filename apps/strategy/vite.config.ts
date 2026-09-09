import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const dirname = import.meta.dirname;

// Served at /strategy/ on the same origin as the legacy Hub (see netlify.toml's
// [[redirects]] rule) — base must match exactly so every asset URL Vite emits resolves
// correctly once deployed, not just in local dev.
export default defineConfig({
  base: "/strategy/",
  plugins: [react()],
  build: {
    outDir: "../../dist/strategy",
    emptyOutDir: true,
  },
  // Vite's dev server restricts filesystem access to the project root by default
  // (server.fs.strict) — allow the repo root too, so this app can import
  // ../../design-tokens.css (the shared token file the legacy Hub also links to) as a
  // genuine single source of truth instead of a copy that has to be kept in sync by hand.
  server: {
    fs: { allow: [path.resolve(dirname, "../..")] },
  },
});
