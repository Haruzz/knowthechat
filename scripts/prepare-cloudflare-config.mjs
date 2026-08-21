import { readFile, writeFile } from "node:fs/promises";

const configPath = new URL("../dist/server/wrangler.json", import.meta.url);
const config = JSON.parse(await readFile(configPath, "utf8"));

// Vinext currently emits this retired Wrangler option. Service environments
// now always behave like the former `legacy_env = true` default, so removing it
// does not change the Worker name or deployment target.
delete config.legacy_env;

await writeFile(configPath, `${JSON.stringify(config)}\n`);
