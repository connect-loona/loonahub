# Strategy OS Firebase rules

`strategy-rules.fragment.json` is the reviewed rule block for every Strategy OS root.
Authenticated team browsers may read live state; browser writes are denied. All writes go
through authenticated Netlify Functions using `FIREBASE_ADMIN_SERVICE_ACCOUNT`.

Firebase Realtime Database deploys replace the complete rules document. Do not deploy this
fragment by itself: export the live rules, merge these nine top-level entries under its
existing `rules` object, review inherited parent grants, then deploy the complete document.
In particular, a permissive parent `.write` must be removed because a child `false` cannot
revoke a permission already granted by an ancestor.

Required Netlify environment variables:

- `FIREBASE_ADMIN_SERVICE_ACCOUNT`: JSON key for the Firebase project service account,
  scoped to Functions.
- `STRATEGY_INTERNAL_SECRET`: a long random value shared only by Strategy functions.
- `FIREBASE_WEB_API_KEY`: the Firebase web key (the existing project default is retained
  temporarily for compatibility).

After merging the rules, use the Firebase Rules Playground or emulator to verify:

1. signed-in reads under each `strategy_*` root succeed;
2. signed-out reads fail;
3. all client writes fail, signed in or not;
4. Strategy Netlify Functions can still read and write through the service account.
