/**
 * Every field that reaches a model, a digest or a log passes through here.
 * Spam is adversarial input: strip anything that could hide or reorder text.
 */

// C0 and C1 control characters (newlines and tabs included: fields are single-line).
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
// Bidi overrides/isolates, zero-width characters and the BOM: they can make
// text render differently from what a model or a person reads.
const INVISIBLE = /[؜­᠎​-‏‪-‮⁠-⁯﻿]/g;

const ASCII = /^[\x00-\x7f]*$/;

export const LIMITS = {
  subject: 200,
  name: 100,
  address: 254,
  preview: 200,
} as const;

/** Single-line, visible-characters-only, at most `max` code points. */
export function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // ASCII is already NFC; skipping normalize() for it saves real CPU per run.
  const s = (ASCII.test(value) ? value : value.normalize("NFC")).replace(CONTROL, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  // A string's UTF-16 length is never below its code-point count, so a short
  // one can't need truncating and doesn't need splitting into code points.
  if (s.length <= max) return s;
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 1)).join("").trimEnd() + "…";
}

/** Lower-cased, cleaned address. Not validated: JMAP allows non-addr-spec values. */
export function cleanAddress(value: unknown): string {
  return clean(value, LIMITS.address).toLowerCase();
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).toLowerCase() : "";
}
