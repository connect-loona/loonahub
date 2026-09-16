import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const dirname = import.meta.dirname;

// Strategy is used on phones and tablets where a cached HTML document can outlive one
// Netlify asset deploy. If its hashed CSS file then misses (or the SPA fallback answers that
// request with index.html), React still mounts but the entire workspace collapses into raw
// unstyled controls. Keep the JavaScript chunk cacheable, but put the relatively small app
// stylesheet directly in index.html so the first document is always visually complete.
function inlineStrategyCss(): Plugin {
  return {
    name: "inline-strategy-css",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find(
        (entry) => entry.type === "asset" && entry.fileName === "index.html",
      );
      if (!html || html.type !== "asset") throw new Error("Strategy build did not emit index.html");

      let document = String(html.source);
      const cssEntries = Object.entries(bundle).filter(
        ([, entry]) => entry.type === "asset" && entry.fileName.endsWith(".css"),
      );
      if (cssEntries.length === 0) throw new Error("Strategy build did not emit a stylesheet to inline");

      for (const [bundleKey, entry] of cssEntries) {
        if (entry.type !== "asset") continue;
        const css = entry;
        const href = `/strategy/${css.fileName}`;
        const escapedHref = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const link = new RegExp(`<link\\s+[^>]*href=["']${escapedHref}["'][^>]*>`, "i");
        if (!link.test(document)) {
          throw new Error(`Strategy index.html does not reference emitted stylesheet ${href}`);
        }
        const safeCss = String(css.source).replace(/<\/style/gi, "<\\/style");
        document = document.replace(link, `<style data-loona-strategy-css>${safeCss}</style>`);
        delete bundle[bundleKey];
      }

      html.source = document;
    },
  };
}

// Served at /strategy/ on the same origin as the legacy Hub (see netlify.toml's
// [[redirects]] rule) — base must match exactly so every asset URL Vite emits resolves
// correctly once deployed, not just in local dev.
export default defineConfig({
  base: "/strategy/",
  plugins: [react(), inlineStrategyCss()],
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
