// Builds Needl for Vercel using the Build Output API: static frontend + one Node function for /api.
import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const output = fileURLToPath(new URL("../../../.vercel/output/", import.meta.url));
const functionDir = `${output}functions/api.func/`;

await rm(output, { recursive: true, force: true });
await mkdir(functionDir, { recursive: true });

// Frontend: Vite has already built apps/web/dist.
await cp(`${webRoot}dist`, `${output}static`, { recursive: true });

// API: one ESM bundle. CommonJS dependencies (pg) need a real require.
await build({
  entryPoints: [`${webRoot}backend/vercel.ts`],
  outfile: `${functionDir}index.mjs`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["pg-native"],
  banner: { js: "import { createRequire as __needlRequire } from 'node:module'; const require = __needlRequire(import.meta.url);" },
  logLevel: "warning",
});
await writeFile(`${functionDir}.vc-config.json`, JSON.stringify({
  runtime: "nodejs22.x",
  handler: "index.mjs",
  launcherType: "Nodejs",
  shouldAddHelpers: false,
  maxDuration: 60,
}, null, 2));

const securityHeaders = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

await writeFile(`${output}config.json`, JSON.stringify({
  version: 3,
  routes: [
    { src: "/api/(.*)", dest: "/api" },
    { src: "/assets/(.*)", headers: { "cache-control": "public, max-age=31536000, immutable", ...securityHeaders }, continue: true },
    { src: "/(.*)", headers: securityHeaders, continue: true },
    { handle: "filesystem" },
    { src: "/(.*)", dest: "/index.html", headers: { "cache-control": "no-store" } },
  ],
  // Hobby plans allow a daily cron; requests from the open UI keep rules advancing in between.
  crons: [{ path: "/api/cron/tick", schedule: "0 0 * * *" }],
}, null, 2));

process.stdout.write(`Vercel output written to ${output}\n`);
