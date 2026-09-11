"use strict";

const crypto = require("crypto");

const SIGNATURE_HEADER = "x-loona-strategy-signature";
const TIMESTAMP_HEADER = "x-loona-strategy-timestamp";
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function signingSecret() {
  return process.env.STRATEGY_INTERNAL_SECRET || "";
}

function signatureFor(timestamp, body, secret) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function getHeader(headers, name) {
  const source = headers || {};
  const key = Object.keys(source).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(source[key] || "") : "";
}

function safeEqual(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function signedHeaders(body, now = Date.now()) {
  const secret = signingSecret();
  if (!secret) throw new Error("STRATEGY_INTERNAL_SECRET is not configured.");
  const timestamp = String(now);
  return {
    "Content-Type": "application/json",
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: signatureFor(timestamp, body, secret),
  };
}

function verifyInternalRequest(event, now = Date.now()) {
  const secret = signingSecret();
  if (!secret) return { ok: false, reason: "Background signing is unavailable." };
  const timestamp = getHeader(event && event.headers, TIMESTAMP_HEADER);
  const received = getHeader(event && event.headers, SIGNATURE_HEADER);
  if (!/^\d{13}$/.test(timestamp) || !received) return { ok: false, reason: "Missing request signature." };
  if (Math.abs(now - Number(timestamp)) > MAX_CLOCK_SKEW_MS) return { ok: false, reason: "Expired request signature." };
  const expected = signatureFor(timestamp, String((event && event.body) || ""), secret);
  return safeEqual(received, expected) ? { ok: true } : { ok: false, reason: "Invalid request signature." };
}

module.exports = { MAX_CLOCK_SKEW_MS, SIGNATURE_HEADER, TIMESTAMP_HEADER, signedHeaders, verifyInternalRequest };
