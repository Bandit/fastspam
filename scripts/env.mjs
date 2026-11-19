/**
 * Shared by the scripts: a real `env` for running fastspam's code locally.
 * getPlatformProxy gives the same bindings as the deployed Worker, with the AI
 * binding proxied to your Cloudflare account (run `npx wrangler login` first).
 * KV is a throwaway in-memory store, so local runs never touch production state.
 */
import { readFileSync, existsSync } from "node:fs";
import { getPlatformProxy } from "wrangler";

export function parseDevVars(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export async function loadEnv() {
  const proxy = await getPlatformProxy({ persist: false });
  const env = { ...proxy.env, ...parseDevVars(".dev.vars") };
  return { env, dispose: () => proxy.dispose() };
}

export function flag(name) {
  return process.argv.includes(`--${name}`);
}

export function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
