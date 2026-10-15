import { createAuthOptions, migrateAuthDatabase } from "./auth.js";
import { createDatabaseRuntime, migrateApplicationDatabase } from "./database.js";

const runtime = createDatabaseRuntime();
try {
  const options = createAuthOptions(runtime);
  await migrateAuthDatabase(options);
  await migrateApplicationDatabase(runtime);
  process.stdout.write(`Needl database migrations applied (${runtime.type}: ${runtime.resource})\n`);
} finally {
  await runtime.close();
}
