"use strict";
const crypto = require("crypto");

const SIGNATURE_HEADER = "x-loona-background-signature";
const TIMESTAMP_HEADER = "x-loona-background-timestamp";
const MAX_AGE_MS = 5 * 60 * 1000;

function signingSecret() {
  return String(process.env.VISUAL_JOB_SECRET || process.env.BASIC_AUTH_CREDENTIALS || "");
}

function signatureFor(functionName, timestamp, body) {
  const secret = signingSecret();
  if (!secret) throw new Error("VISUAL_JOB_SECRET or BASIC_AUTH_CREDENTIALS is required for background jobs.");
  return crypto
    .createHmac("sha256", secret)
    .update(`${functionName}\n${timestamp}\n${body}`)
    .digest("hex");
}

function signedBackgroundHeaders(functionName, body, now = Date.now()) {
  const timestamp = String(now);
  return {
    "Content-Type": "application/json",
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: signatureFor(functionName, timestamp, body),
  };
}

function verifyBackgroundRequest(functionName, timestamp, body, signature, now = Date.now()) {
  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp) || Math.abs(now - numericTimestamp) > MAX_AGE_MS) return false;
  let expected;
  try { expected = Buffer.from(signatureFor(functionName, String(timestamp), body), "hex"); }
  catch { return false; }
  const actual = Buffer.from(String(signature || ""), "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signedBackgroundHeaders,
  verifyBackgroundRequest,
};
