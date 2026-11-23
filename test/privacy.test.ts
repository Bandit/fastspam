/**
 * This repository is public. Fail the build if anything committed contains an
 * email address outside the RFC 2606 / RFC 6761 reserved names, so a real
 * address or a pasted real subject line cannot slip in unnoticed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const RESERVED = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;

function committedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
  return out.split("\n").filter((f) => f && !f.endsWith("package-lock.json") && !/\.(png|jpe?g|gif|ico|pdf)$/i.test(f));
}

describe("privacy", () => {
  it("contains no real email addresses", () => {
    const offenders: string[] = [];
    for (const file of committedFiles()) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(EMAIL)) {
        const addr = m[0];
        const domain = addr.split("@")[1]!.replace(/\.$/, "");
        if (!RESERVED.test(domain)) offenders.push(`${file}: ${addr}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not track local secrets or private evaluation data", () => {
    const files = committedFiles();
    expect(files.filter((f) => /(^|\/)\.dev\.vars$|^eval-private\/|^eval-results\//.test(f))).toEqual([]);
  });

  // Runs only where a .dev.vars exists (the maintainer's machine), so the
  // values it checks for never need to be written into the repository.
  it.skipIf(!existsSync(".dev.vars"))("contains none of your local .dev.vars personal values", () => {
    const PERSONAL = /TOKEN|^EMAIL_|MAILBOX|TIMEZONE|GATEWAY/;
    const GENERIC = new Set(["inbox", "spam", "junk", "archive", "quarantine", "sent", "trash", "utc", "fastspam"]);
    const values: { key: string; value: string }[] = [];
    for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m || !PERSONAL.test(m[1]!)) continue;
      for (const raw of m[2]!.split(",")) {
        const value = raw.trim().replace(/^["']|["']$/g, "");
        if (value.length >= 4 && !GENERIC.has(value.toLowerCase())) values.push({ key: m[1]!, value: value.toLowerCase() });
      }
    }
    const offenders: string[] = [];
    for (const file of committedFiles()) {
      const text = readFileSync(file, "utf8").toLowerCase();
      // Name the key, never the value: this output can end up in CI logs.
      for (const { key, value } of values) if (text.includes(value)) offenders.push(`${file}: value of ${key}`);
    }
    expect(offenders).toEqual([]);
  });

  it("commits no KV namespace id (wrangler provisions it on first deploy)", () => {
    expect(readFileSync("wrangler.jsonc", "utf8")).not.toMatch(/"id":\s*"[0-9a-f]{32}"/);
  });
});
