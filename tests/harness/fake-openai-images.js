// A stand-in for the OpenAI endpoints Visual Studio calls, so the whole production path —
// create a job, kick the background worker, poll, store the bytes, serve them back — can run
// in a test without a key, without a network, and without spending money on images nobody
// will look at.
//
// This exists because the alternative was worse. The branch previously routed browser tests
// down a separate synchronous code path, which meant the job machinery that actually ships had
// no browser coverage at all, and the suite stayed green precisely because it never ran it.
//
// Deliberately slow-ish on request: a generation that returned instantly would never let a
// test observe a job while it is still queued or running, and "still running" is the state the
// whole reconnect-after-refresh behaviour exists to handle.
"use strict";
const http = require("http");

const PORT = process.env.FAKE_OPENAI_PORT || 9040;

// A 1x1 PNG. Small enough to be free, real enough to survive a signature check — though
// generated images skip the dimension floor that references have to clear.
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const url = req.url.split("?")[0];

    // The prompt rewrite. Returns something recognisable so a test can assert that what the
    // image model received is the REWRITTEN prompt, not the four words somebody typed.
    if (url.endsWith("/responses")) {
      return json(res, 200, { output_text: "A rewritten, self-contained image prompt with the whole scene described." });
    }

    if (url.endsWith("/images/generations") || url.endsWith("/images/edits")) {
      // A deliberate pause. Without it a job goes from queued to succeeded between two polls
      // and the "reconnect to work already in flight" path is never actually exercised.
      const delay = Number(process.env.FAKE_OPENAI_DELAY_MS || 1200);
      await new Promise((resolve) => setTimeout(resolve, delay));
      let count = 1;
      try { count = Math.max(1, Math.min(4, Number(JSON.parse(body).n) || 1)); } catch { count = 1; }
      return json(res, 200, {
        data: Array.from({ length: count }, () => ({ b64_json: PNG_1PX, revised_prompt: "what the provider decided to draw" })),
      });
    }

    return json(res, 404, { error: { message: `fake-openai: no route for ${url}` } });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake OpenAI images listening on http://127.0.0.1:${PORT}`);
});
