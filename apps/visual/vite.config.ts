import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const dirname = import.meta.dirname;

// Served at /visual/ on the same origin as the legacy Hub and Strategy OS (see netlify.toml's
// [[redirects]] rule) — base must match exactly so every asset URL Vite emits resolves once
// deployed, not just in local dev. Same arrangement as apps/strategy.
export default defineConfig({
  base: "/visual/",
  plugins: [react()],
  build: {
    outDir: "../../dist/visual",
    emptyOutDir: true,
  },
  server: {
    fs: { allow: [path.resolve(dirname, "../..")] },
  },
});
