// Authenticating Hub's database calls.
//
// Every Netlify Function in this repo reads and writes the Realtime Database over plain REST,
// and none of them used to authenticate. That is why the database had to accept
// unauthenticated reads AND writes from anyone — while its URL sat hard-coded in a public
// repository and shipped inside the browser bundle. The rules could not be closed until the
// functions could prove who they are.
//
// Two properties are load-bearing, and both are tested here rather than trusted:
//
//   The credential must reach ONLY the database's own host. Several of these functions share a
//   single req() helper between Firebase and PetPooja, Spotify and Google. Attaching the
//   secret to every outbound call would hand Loona's database credential to three third
//   parties — a worse hole than the one being closed.
//
//   It must be a no-op when no secret is configured, so this can ship and be verified before
//   the secret exists, and so removing the secret degrades rather than breaks.
const path = require("path");
const { HUB, check, finish } = require("../harness/shared");
const authModule = path.join(HUB, "netlify/functions/lib/firebase-auth");
const { authedUrl, isDatabaseUrl, databaseUrl } = require(authModule);

const DB = "https://loona-hub-c85d7-default-rtdb.firebaseio.com";

(async () => {
  // ---- No secret configured: nothing changes ----
  delete process.env.FIREBASE_DB_SECRET;
  check("with no secret the URL is returned exactly as built",
    authedUrl(`${DB}/brands.json`) === `${DB}/brands.json`, authedUrl(`${DB}/brands.json`));

  // ---- With a secret ----
  process.env.FIREBASE_DB_SECRET = "test-db-secret";
  const plain = authedUrl(`${DB}/brands.json`);
  check("the credential is attached to a database call", /[?]auth=test-db-secret$/.test(plain), plain);

  // shallow=, orderBy= and limitToLast= are all in use in this repo, so an existing query
  // string has to survive rather than be clobbered.
  const withQuery = authedUrl(`${DB}/tasks.json?orderBy=%22brand%22&limitToLast=50`);
  check("an existing query string is preserved and the credential appended",
    /orderBy=%22brand%22/.test(withQuery) && /&auth=test-db-secret$/.test(withQuery), withQuery);

  check("a URL that already carries a credential is not given a second one",
    authedUrl(`${DB}/brands.json?auth=already`) === `${DB}/brands.json?auth=already`,
    authedUrl(`${DB}/brands.json?auth=already`));

  // ---- THE ONE THAT MATTERS: the secret must not leak ----
  // These are real hosts this repo calls, several of them through the very same req() helper
  // that now attaches the credential.
  const thirdParties = [
    "https://api.openai.com/v1/images/generations",
    "https://api.anthropic.com/v1/messages",
    "https://accounts.spotify.com/api/token",
    "https://payrolltp.petpooja.com/api/attendance",
    "https://sheets.googleapis.com/v4/spreadsheets/abc/values/A1",
    "https://www.googleapis.com/oauth2/v4/token",
    "https://api.magnific.com/v1/ai/mystic",
  ];
  const leaked = thirdParties.filter((url) => authedUrl(url) !== url);
  check("the database secret is never attached to a third-party API call", leaked.length === 0, leaked);

  // Not "any Firebase host" — another project's database is still somebody else's.
  const otherProject = "https://someone-elses-default-rtdb.firebaseio.com/brands.json";
  check("nor to a different Firebase project", authedUrl(otherProject) === otherProject, authedUrl(otherProject));
  check("and that host is not treated as ours", isDatabaseUrl(otherProject) === false);

  // A malformed URL must fail closed — return it untouched rather than throw or guess.
  check("a URL that cannot be parsed is passed through untouched, not guessed at",
    authedUrl("not a url") === "not a url", authedUrl("not a url"));

  // ---- It follows FIREBASE_DB_URL, which is how the test harness points at a local fake ----
  process.env.FIREBASE_DB_URL = "http://127.0.0.1:9030";
  delete require.cache[require.resolve(authModule)];
  const reloaded = require(authModule);
  check("the database host follows FIREBASE_DB_URL rather than being pinned to production",
    reloaded.databaseUrl() === "http://127.0.0.1:9030", reloaded.databaseUrl());
  check("and production is then no longer treated as ours",
    reloaded.authedUrl(`${DB}/brands.json`) === `${DB}/brands.json`);

  delete process.env.FIREBASE_DB_URL;
  delete process.env.FIREBASE_DB_SECRET;
  check("the default database is the one Hub actually uses", /loona-hub-c85d7/.test(databaseUrl()), databaseUrl());

  // ---- The helper being correct and the helper being WIRED IN are different claims ----
  // Everything above tests a pure function. None of it would notice if the helper were never
  // called — which is the failure that would matter, because it would look exactly like
  // success right up until the rules were closed and every function started failing at once.
  //
  // So: stand up a throwaway server, point the database at it, and inspect what actually goes
  // over the wire. Writes matter as much as reads here; an unauthenticated PUT is how a
  // stranger would have been able to overwrite a client's brand.
  const http = require("http");
  const received = [];
  const server = http.createServer((request, response) => {
    received.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  process.env.FIREBASE_DB_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.FIREBASE_DB_SECRET = "wired-in-secret";
  for (const mod of ["netlify/functions/lib/firebase-auth", "netlify/functions/lib/strategy/firebase"]) {
    delete require.cache[require.resolve(path.join(HUB, mod))];
  }
  const fb = require(path.join(HUB, "netlify/functions/lib/strategy/firebase"));
  await fb.fbGet("strategy_runs");
  await fb.fbSet("strategy_brain/rro-foods", { distilled: true });
  await fb.fbPush("strategy_activity", { what: "test" });
  await new Promise((resolve) => server.close(resolve));

  check("reads, writes and pushes all reach the database", received.length === 3, received);
  check("and every one of them carried the credential",
    received.every((r) => r.includes("auth=wired-in-secret")), received);
  check("specifically the write, which is what a stranger could otherwise have done",
    received.some((r) => r.startsWith("PUT ") && r.includes("auth=wired-in-secret")), received);

  delete process.env.FIREBASE_DB_URL;
  delete process.env.FIREBASE_DB_SECRET;

  finish();
})().catch((e) => { console.error("FATAL:", e, e.stack); process.exit(1); });
