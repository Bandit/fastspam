#!/usr/bin/env node
/**
 * npm run deploy: `wrangler deploy` with your own settings applied.
 *
 * Settings live in .dev.vars (git-ignored), next to your local secrets, so the
 * committed wrangler.jsonc keeps neutral defaults. For every key in .dev.vars
 * that is also a setting in wrangler.jsonc's "vars" (AI_MODEL, AI_GATEWAY_ID,
 * TIMEZONE, ...), this passes `--var KEY:VALUE` to override the default for the
 * deploy. Anything else in .dev.vars (tokens, addresses) is never passed: as a
 * plain var it would be visible in the dashboard. Set those once with
 * `npx wrangler secret put NAME`.
 *
 * DRY_RUN is never taken from .dev.vars, so a local DRY_RUN=true can't switch
 * production off. Extra arguments are passed through to wrangler:
 *
 *   npm run deploy
 *   npm run deploy -- --dry-run --outdir dist
 */
import { spawnSync } from "node:child_process";
import { experimental_readRawConfig } from "wrangler";
import { parseDevVars } from "./env.mjs";

const LOCAL_ONLY = new Set(["DRY_RUN"]);

const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });
const settings = new Set(Object.keys(rawConfig.vars ?? {}));
const local = parseDevVars(".dev.vars");

const overrides = Object.entries(local).filter(([k]) => settings.has(k) && !LOCAL_ONLY.has(k));
const ignored = Object.keys(local).filter((k) => LOCAL_ONLY.has(k) && settings.has(k));

if (overrides.length) {
  console.log("Settings from .dev.vars for this deploy:");
  for (const [k, v] of overrides) console.log(`  ${k}=${v}`);
} else {
  console.log("No settings in .dev.vars override wrangler.jsonc; deploying its defaults.");
}
if (ignored.length) console.log(`Not applied (local only): ${ignored.join(", ")}`);

const args = ["wrangler", "deploy", ...overrides.flatMap(([k, v]) => ["--var", `${k}:${v}`]), ...process.argv.slice(2)];
const result = spawnSync("npx", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
