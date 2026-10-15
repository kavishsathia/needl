import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabaseRuntime, migrateApplicationDatabase } from "./database.js";
import { NeedlRepository } from "./repository.js";

interface IntegrationInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly provider: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly secretEnvName: string;
  readonly enabled: boolean;
}

function validate(value: unknown): readonly IntegrationInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Integration file must contain a non-empty JSON array");
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`Integration ${index + 1} must be an object`);
    const candidate = item as Partial<IntegrationInput>;
    if (candidate.id !== undefined && (typeof candidate.id !== "string" || !/^int_[A-Za-z0-9_-]{3,100}$/.test(candidate.id))) throw new Error(`Integration ${index + 1} has an invalid id`);
    if (typeof candidate.tenantId !== "string" || !candidate.tenantId.startsWith("ten_")) throw new Error(`Integration ${index + 1} has an invalid tenantId`);
    if (typeof candidate.provider !== "string" || candidate.provider.length === 0) throw new Error(`Integration ${index + 1} has an invalid provider`);
    if (typeof candidate.config !== "object" || candidate.config === null || Array.isArray(candidate.config)) throw new Error(`Integration ${index + 1} has an invalid config`);
    if (typeof candidate.secretEnvName !== "string") throw new Error(`Integration ${index + 1} needs a secretEnvName`);
    if (typeof candidate.enabled !== "boolean") throw new Error(`Integration ${index + 1} needs an explicit enabled boolean`);
    return candidate as IntegrationInput;
  });
}

const file = process.argv[2];
if (file === undefined) throw new Error("Usage: npm run db:configure-integrations -- /restricted/path/integrations.json");
const inputs = validate(JSON.parse(await readFile(resolve(file), "utf8")));
const runtime = createDatabaseRuntime();
try {
  await migrateApplicationDatabase(runtime);
  const repository = new NeedlRepository(runtime);
  const ids: string[] = [];
  for (const input of inputs) ids.push((await repository.upsertIntegration(input)).id);
  process.stdout.write(`Configured ${ids.length} Needl integration record(s): ${ids.join(", ")}\n`);
} finally {
  await runtime.close();
}
