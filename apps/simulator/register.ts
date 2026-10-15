import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { integrationsPath } from "./config.js";

// Writes the simulator's integration records into the same database the Needl server uses.
const web = fileURLToPath(new URL("../web", import.meta.url));
const result = spawnSync("npm", ["--prefix", web, "run", "db:configure-integrations", "--", integrationsPath], { stdio: "inherit" });
process.exit(result.status ?? 1);
