import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SimulatedProvider } from "./events.js";

export const providers: readonly SimulatedProvider[] = ["gitlab", "sentry", "stripe", "linear"];

/** Generated secrets and routing live outside the repository's tracked files. */
export const stateDirectory = resolve(process.env.SIMULATOR_STATE_DIR ?? join(fileURLToPath(new URL(".", import.meta.url)), "../../.simulator"));
export const configPath = join(stateDirectory, "config.json");
export const secretsPath = join(stateDirectory, "secrets.env");
export const integrationsPath = join(stateDirectory, "integrations.json");

export interface SimulatorConfig {
  readonly needlUrl: string;
  readonly tenantId: string;
  readonly integrations: Readonly<Record<SimulatedProvider, { readonly id: string; readonly secretEnvName: string }>>;
}

export function integrationId(provider: SimulatedProvider): string {
  return `int_sim_${provider}`;
}

export function secretEnvName(provider: SimulatedProvider): string {
  return `NEEDL_SIM_${provider.toUpperCase()}_SECRET`;
}

export function loadConfig(): SimulatorConfig {
  if (!existsSync(configPath)) throw new Error(`Run "npm run sim:setup -- <tenantId>" first; ${configPath} does not exist`);
  return JSON.parse(readFileSync(configPath, "utf8")) as SimulatorConfig;
}

export function loadSecrets(config: SimulatorConfig): Readonly<Record<SimulatedProvider, string>> {
  if (existsSync(secretsPath)) process.loadEnvFile(secretsPath);
  const secrets = {} as Record<SimulatedProvider, string>;
  for (const provider of providers) {
    const value = process.env[config.integrations[provider].secretEnvName];
    if (value === undefined || value.length === 0) throw new Error(`${config.integrations[provider].secretEnvName} is not set`);
    secrets[provider] = value;
  }
  return secrets;
}
