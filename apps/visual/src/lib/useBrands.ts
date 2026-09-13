// Visual Studio's brand list comes from Hub's own `brands` node, not from a list maintained
// here. That's the same rule Strategy OS's New Run picker follows (see useAllHubBrands in
// apps/strategy) and the same reason: Hub is where brands are actually added and removed, so
// anything that keeps its own copy drifts the moment somebody onboards a client.
//
// Both UI prototypes hardcoded four brands with hand-written colours. That's fine for a
// mockup and wrong for the real thing — a brand added in Hub on Monday has to be here on
// Monday, without a deploy.
import { useEffect, useState } from "react";
import { listenPath } from "./firebase";
import type { VisualBrand } from "./types";

function slug(value: string): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// A stable colour per brand so each project reads as its own space, derived from the brand's
// own id rather than stored. The prototypes assigned these by hand, which doesn't survive a
// fifth brand.
export function brandColour(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${hash} 38% 42%)`;
}

export function useHubBrands(): { brands: VisualBrand[]; loading: boolean } {
  const [raw, setRaw] = useState<Record<string, { brand?: string; inactive?: boolean }> | null>(null);

  useEffect(() => listenPath<Record<string, { brand?: string; inactive?: boolean }>>("brands", setRaw), []);

  if (raw === null) return { brands: [], loading: true };

  const seen = new Set<string>();
  const brands: VisualBrand[] = [];
  for (const record of Object.values(raw || {})) {
    // An inactive brand is one Hub has deliberately retired — it shouldn't offer a place to
    // start new work, even though its past chats remain readable by id.
    if (!record || !record.brand || record.inactive) continue;
    const id = slug(record.brand);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    brands.push({ id, name: record.brand });
  }
  brands.sort((a, b) => a.name.localeCompare(b.name));
  return { brands, loading: false };
}
