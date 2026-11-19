import { domainOf } from "./sanitise.ts";

/**
 * Sender patterns for ALWAYS_REPORT / NEVER_REPORT, matched case-insensitively:
 *
 *   alice@example.com     exactly that address
 *   example.com           that domain and its subdomains (also "@example.com")
 *   *@example.com         same as above
 *   news-*@example.com    `*` is a wildcard within an address pattern
 */
export function matchesPattern(address: string, pattern: string): boolean {
  const addr = address.trim().toLowerCase();
  let p = pattern.trim().toLowerCase();
  if (!addr || !p) return false;
  if (p.startsWith("*@")) p = p.slice(1);
  if (p.startsWith("@")) p = p.slice(1);

  if (!p.includes("@")) {
    const domain = domainOf(addr);
    return domain === p || domain.endsWith("." + p);
  }
  if (!p.includes("*")) return addr === p;
  const re = new RegExp("^" + p.split("*").map(escapeRegExp).join("[^@]*") + "$");
  return re.test(addr);
}

export function matchesAny(address: string, patterns: readonly string[]): string | undefined {
  return patterns.find((p) => matchesPattern(address, p));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
