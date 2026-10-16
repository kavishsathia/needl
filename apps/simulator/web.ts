import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { secretsPath } from "./config.js";

// Starts Needl's dev servers with the signing secrets the simulator uses.
if (!existsSync(secretsPath)) throw new Error(`Run "npm run sim:setup -- <tenantId>" first; ${secretsPath} does not exist`);
process.loadEnvFile(secretsPath);
const root = fileURLToPath(new URL("../..", import.meta.url));
// Optional local settings such as OPENAI_API_KEY for the translator; .env is gitignored.
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
const result = spawnSync("npm", ["run", "web:dev"], { cwd: root, stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
