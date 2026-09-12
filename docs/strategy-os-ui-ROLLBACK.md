# Strategy OS UI redesign — rollback

**Date:** 2026-09-12  
**Live main tip before this ship (rollback target):** `9bf8253061653075034caa2913b4d3f9cbe768a4` (`9bf8253`) — “Try refined Strategy OS UI…” (still table home; under-shipped).  
**Deeper known-good:** `e6b1386a56fbc27a4af5427e0c56eebb224548ac` (`e6b1386`)  
**Note:** `29d4d8d` on main (failover/production fixes) may sit above `9bf8253`; prefer reverting *this* UI commit, or resetting only listed files, rather than hard-resetting past unrelated fixes.  
**Working copy:** `/workspace/loona-hub-previews/loonahub-deploy/`  
**Do not push from this box** — commit via GitHub browser / parent agent.

## What this change does (must look different at a glance)

1. **Home / runs list** — dense `<table>` replaced with Hub-scale **run cards** (logo/initials, brand, month, stage + agent emoji, status pill, Open). Active / Archived **pills**.
2. **Stage rail** — persona emoji + name + role; **stronger** pulse + working dots while running/repairing.
3. **Strategy review** — one concept dominant at a time; Approve / Tweak / Skip bar; optional Show all; concept name as title.
4. **Brand Memory** — slim vertical **drawer tab** (expand to panel); `.st-workspace-side` + “Brand memory” kept for e2e.
5. **Friendly next-action errors** — short human copy + Retry; technical detail collapsed.
6. Hub-scale shell (~13px body, ~32px agents, max-width ~920px). `/strategy/` stays primary; **Strategy legacy** / `/?so=legacy` / `/strategy-old/` unchanged.

Pipeline / Netlify functions / backend behavior unchanged.

## Files changed (commit these)

```
apps/strategy/src/pages/RunList.tsx
apps/strategy/src/pages/RunDetail.tsx
apps/strategy/src/components/BrandMemory.tsx
apps/strategy/src/components/StrategyReview.tsx
apps/strategy/src/components/NextActionCard.tsx
apps/strategy/src/styles/components.css
tests/e2e/strategy-react-run-list.spec.js
docs/strategy-os-ui-ROLLBACK.md
```

(No backend / `netlify/functions` edits. StageRail.tsx already had persona markup from `9bf8253`.)

## How to revert

### Option A — restore tip `9bf8253` files (undo this visual redesign)

```bash
git checkout 9bf8253061653075034caa2913b4d3f9cbe768a4 -- \
  apps/strategy/src/pages/RunList.tsx \
  apps/strategy/src/pages/RunDetail.tsx \
  apps/strategy/src/components/BrandMemory.tsx \
  apps/strategy/src/components/StrategyReview.tsx \
  apps/strategy/src/components/NextActionCard.tsx \
  apps/strategy/src/styles/components.css \
  tests/e2e/strategy-react-run-list.spec.js \
  docs/strategy-os-ui-ROLLBACK.md
```

Then rebuild / redeploy (`cd apps/strategy && npm ci && npm run build`).

### Option B — deeper rollback to `e6b1386`

```bash
git checkout e6b1386a56fbc27a4af5427e0c56eebb224548ac -- \
  apps/strategy/src/App.tsx \
  apps/strategy/src/components/StageRail.tsx \
  apps/strategy/src/components/StrategyReview.tsx \
  apps/strategy/src/components/BrandMemory.tsx \
  apps/strategy/src/components/NextActionCard.tsx \
  apps/strategy/src/pages/RunDetail.tsx \
  apps/strategy/src/pages/RunList.tsx \
  apps/strategy/src/styles/components.css \
  index.html \
  tests/e2e/strategy-react-run-list.spec.js \
  docs/strategy-os-ui-ROLLBACK.md
```

Or full tip reset only if safe (never if shared history includes unrelated fixes after `e6b1386`):

```bash
git reset --hard e6b1386a56fbc27a4af5427e0c56eebb224548ac
```

### Option C — runtime rollback without redeploying Hub statics

- Hub nav **“Strategy legacy”** or `https://<host>/?so=legacy` for old `#page-strategy`.
- Frozen snapshot at `/strategy-old/` if still published.
- React `/strategy/` keeps last built assets until you redeploy A/B.

## Build check

```bash
cd apps/strategy && npm ci && npm run build
# → tsc -b && vite build must succeed (dist/strategy/)
```

## Success criteria

Someone opening `/strategy/` immediately sees **cards**, not a spreadsheet table; run view shows **persona rail** + **one-concept** review (Brand Memory as slim tab).

## Not in this change

- `changes_requested` → Retry (backend still limited).
- Copy / Creative one-at-a-time bars (Strategy stage only).
- Month ops board / deep links / duplicate-run guard.
