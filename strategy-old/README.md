# /strategy-old/ — rollback snapshot

This is a **frozen** copy of the legacy Strategy OS experience (`index.html`,
`app.js`, `strategy-app.js`, `strategy-ui.js`, `design-tokens.css`), taken the
moment the new React app at `/strategy/` reached feature parity — see the
working-instructions doc's own closing note: "the old implementation stays
reachable at `/strategy-old/` for a month as an escape hatch."

It is deliberately **not** kept in sync with the live files of the same name
at the repo root — those keep evolving with the rest of Hub, this doesn't.
That's the point: if something in the new app needs a real fallback, this is
a known-good, untouched copy of what shipped right before the cutover,
immune to whatever's changed since.

Served at `/strategy-old/` by `scripts/build-dist.js` copying this directory
verbatim into `dist/strategy-old/` — no `netlify.toml` redirect needed, since
Netlify already resolves a directory request to its own `index.html` the
same way it does for the site root. Its own `assets/`, `icons/`, etc.
references stay absolute paths (`/assets/...`), so they resolve against the
live `dist/assets/` — visual assets aren't expected to diverge, only the
code files frozen here.

**Delete this directory** (and its `LEGACY_DIRS`/`LEGACY_FILES`-style entry
in `scripts/build-dist.js`) once the rollback window has passed — nothing
else references it.
