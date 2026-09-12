# Strategy OS UI refinements — rollback

**Date:** 2026-09-12  
**Base (previous main SHA to restore):** `e6b1386a56fbc27a4af5427e0c56eebb224548ac` (`e6b1386`)  
**Working copy:** `/workspace/loona-hub-previews/loonahub-deploy/`  
**Do not push from this box** — commit via GitHub browser / parent agent.

## What this change does

Visible UI refinements in the React Strategy app (`apps/strategy/`) plus Hub nav cutover:

1. **Persona stage rail** — fixed agent emoji/name/role on every stage (Columbus / Dora / Matilda / Barbie / Bob); pulse + working dots while a stage is running/repairing.
2. **One-concept review** — Strategy concepts in a scroll-snap carousel with **Approve / Tweak / Skip** Hub-scale bar (Approve = lock + next; Tweak = open refine; Skip = next). “Show all” toggle available. All rows stay mounted for e2e.
3. **Hub-scale shell** — max-width ~920px, tighter padding/type, sticky mini nav in `/strategy/`.
4. **Actor fix (P0)** — `RunDetail` passes session `actor` into Strategy/Copy/Creative reviews (was `run.owner`).
5. **Nav cutover** — Hub “Strategy OS” → `/strategy/`; “Strategy legacy” + React “Legacy UI” (`/?so=legacy`) keep the old Hub tab reachable.

Pipeline / Netlify functions / backend behavior unchanged.

## Files changed (commit these)

```
apps/strategy/src/App.tsx
apps/strategy/src/components/StageRail.tsx
apps/strategy/src/components/StrategyReview.tsx
apps/strategy/src/pages/RunDetail.tsx
apps/strategy/src/styles/components.css
index.html
```

(No backend / `netlify/functions` edits.)

## How to revert

### Option A — restore previous main tip (full revert of this UI commit)

If this UI work lands as one commit on top of `e6b1386`:

```bash
git revert <this-commit-sha>
# or reset hard only if the commit was never shared:
git reset --hard e6b1386a56fbc27a4af5427e0c56eebb224548ac
```

### Option B — restore only listed files from previous main

```bash
git checkout e6b1386a56fbc27a4af5427e0c56eebb224548ac -- \
  apps/strategy/src/App.tsx \
  apps/strategy/src/components/StageRail.tsx \
  apps/strategy/src/components/StrategyReview.tsx \
  apps/strategy/src/pages/RunDetail.tsx \
  apps/strategy/src/styles/components.css \
  index.html
```

Then rebuild / redeploy (`npm run build` → Netlify).

### Option C — runtime rollback without redeploying Hub statics

- Use Hub nav **“Strategy legacy”** or open `https://<host>/?so=legacy` for the old `#page-strategy` UI.
- Or open frozen snapshot at `/strategy-old/` if that deploy path is still published.
- React app at `/strategy/` will keep serving whatever was last built until you redeploy Option A/B.

## Build check (already run here)

```bash
cd apps/strategy && npm ci && npm run build
# → tsc -b && vite build succeeded (dist/strategy/)
```

## Not in this change

- `changes_requested` → Retry (needs `strategy-stage-retry` to accept that status; today only `failed`).
- Copy / Creative one-at-a-time bars (Strategy stage only for now).
- Month ops board / deep links / duplicate-run guard.
