// Azure Blob Storage's presigned upload URLs (what Sarvam hands back from
// getUploadLinks) don't have CORS enabled for arbitrary browser origins, so a
// direct browser PUT to appsprodpublicsa.blob.core.windows.net gets blocked
// before it ever reaches Azure — the browser fails the request with a generic
// "Load failed" / "Failed to fetch" and no server-side log to show for it.
//
// This relays the upload same-origin instead: the browser PUTs the audio blob
// to this edge function's own URL (no CORS issue, same domain), and the edge
// function does the actual PUT to Azure server-to-server, which is not subject
// to browser CORS restrictions at all.
//
// Runs as an Edge Function (not a regular Netlify Function) specifically because
// regular Functions run on Lambda and are capped at a ~6MB request body — Edge
// Functions run on a different runtime with a much more generous limit, so a
// full meeting recording can pass through here instead of being limited to a
// few minutes of audio.
//
// The client-to-edge and edge-to-Azure legs are streamed concurrently (request.body
// piped straight into the upstream fetch) rather than buffered-then-forwarded —
// buffering the whole body first means the two legs run one after the other, and for
// a long (49+ minute) recording on anything but a fast connection that sequential
// double-hop blows past Netlify's 40-second edge function response-header timeout,
// which silently fails the whole upload. Streaming lets both legs overlap instead.

import type { Context, Config } from "@netlify/edge-functions";

export default async (request: Request, context: Context) => {
  if (request.method !== "PUT") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const targetParam = new URL(request.url).searchParams.get("url");
  if (!targetParam) {
    return new Response(JSON.stringify({ error: "Missing url param" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let target: URL;
  try {
    target = new URL(targetParam);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid url param" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Only ever relay to Sarvam's own blob storage — never let this become an
  // open proxy to an arbitrary attacker-supplied host.
  if (!target.protocol.startsWith("https") || !target.hostname.endsWith(".blob.core.windows.net")) {
    return new Response(JSON.stringify({ error: "Upload target not allowed" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const contentLength = request.headers.get("content-length");
    const upstream = await fetch(target.toString(), {
      method: "PUT",
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "Content-Type": request.headers.get("content-type") || "application/octet-stream",
        ...(contentLength ? { "Content-Length": contentLength } : {}),
      },
      body: request.body,
      // Required by the Fetch spec whenever a streaming ReadableStream is passed
      // as the request body — signals we're not waiting for the full body before
      // the request can start being sent.
      duplex: "half",
    } as RequestInit);
    const text = await upstream.text();
    return new Response(text || null, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/api/sarvam-upload-proxy",
};
