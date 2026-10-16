import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import {
  configPath,
  generateSecrets,
  integrationConfig,
  integrationId,
  integrationsPath,
  providers,
  secretEnvName,
  secretsPath,
  stateDirectory,
  type SimulatorConfig,
} from "./config.js";

const args = process.argv.slice(2);
const tenantId = args.find((arg) => !arg.startsWith("--"));
const urlFlag = args.indexOf("--needl");
const needlUrl = (urlFlag >= 0 ? args[urlFlag + 1] : undefined) ?? "http://127.0.0.1:4174";
if (tenantId !== undefined && !tenantId.startsWith("ten_")) {
  throw new Error("Usage: npm run sim:setup -- [tenantId from /api/workspace] [--needl http://127.0.0.1:4174]");
}
new URL(needlUrl);

mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });

// Keep existing secrets so Needl and the simulator stay in agreement across re-runs.
const existing = existsSync(secretsPath) ? parseEnv(readFileSync(secretsPath, "utf8")) : {};
const generated = generateSecrets();
const secretLines = providers.map((provider) => `${secretEnvName(provider)}=${existing[secretEnvName(provider)] ?? generated[provider]}`);
writeFileSync(secretsPath, `${secretLines.join("\n")}\n`, { mode: 0o600 });

if (tenantId === undefined) {
  process.stdout.write(`Signing secrets ready in ${secretsPath}

Next:
  1. Start Needl with those secrets:            npm run sim:web
  2. Sign up in Needl and copy your tenantId from /api/workspace
  3. Point the simulator at your workspace:     npm run sim:setup -- <tenantId>
`);
  process.exit(0);
}

const integrations = providers.map((provider) => ({
  id: integrationId(provider),
  tenantId,
  provider,
  enabled: true,
  secretEnvName: secretEnvName(provider),
  config: integrationConfig(provider),
}));
writeFileSync(integrationsPath, `${JSON.stringify(integrations, null, 2)}\n`, { mode: 0o600 });

const config: SimulatorConfig = {
  needlUrl: needlUrl.replace(/\/$/, ""),
  tenantId,
  integrations: Object.fromEntries(providers.map((provider) => [provider, { id: integrationId(provider), secretEnvName: secretEnvName(provider) }])) as SimulatorConfig["integrations"],
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

process.stdout.write(`Simulator configured for ${tenantId} → ${config.needlUrl}

Next (Needl must already be running via npm run sim:web, so it holds these secrets):
  1. Register the simulator's integrations:     npm run sim:register
  2. Start the simulator:                       npm run sim
`);
