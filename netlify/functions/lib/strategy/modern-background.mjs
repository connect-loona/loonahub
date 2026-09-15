import backgroundAuth from "./background-auth.js";

const {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyBackgroundRequest,
} = backgroundAuth;

export async function readSignedBackgroundBody(request, functionName) {
  const rawBody = await request.text();
  const valid = verifyBackgroundRequest(
    functionName,
    request.headers.get(TIMESTAMP_HEADER),
    rawBody,
    request.headers.get(SIGNATURE_HEADER),
  );
  if (!valid) {
    console.error(`${functionName} rejected an unsigned, stale, or invalid internal request.`);
    return null;
  }
  try {
    return JSON.parse(rawBody || "{}");
  } catch {
    console.error(`${functionName} rejected invalid JSON.`);
    return null;
  }
}

export const backgroundConfig = Object.freeze({ background: true });
