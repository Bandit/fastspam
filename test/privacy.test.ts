/**
 * This repository is public. Fail the build if anything committed contains an
 * email address outside the RFC 2606 / RFC 6761 reserved names, so a real
 * address or a pasted real subject line cannot slip in unnoticed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

  it("commits no KV namespace id (wrangler provisions it on first deploy)", () => {
    expect(readFileSync("wrangler.jsonc", "utf8")).not.toMatch(/"id":\s*"[0-9a-f]{32}"/);
  });
});
