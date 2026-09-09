import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
});
