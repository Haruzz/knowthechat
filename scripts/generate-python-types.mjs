import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const env = { ...process.env };
if (process.platform === "win32") {
  const loader = new URL("./python-types-loader.mjs", import.meta.url).href;
  const preload = `import { register } from "node:module"; register(${JSON.stringify(loader)});`;
  const importUrl = `data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`;
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${importUrl}`.trim();
}

const child = spawn(
  process.execPath,
  [
    "scripts/with-uv.mjs",
    "run",
    "--locked",
    "--directory",
    "backend",
    "pywrangler",
    "types",
    "--outdir",
    ".wrangler/python-types",
  ],
  { cwd: fileURLToPath(root), env, stdio: "inherit" },
);
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});
if (exitCode !== 0) process.exit(exitCode);

// Pyright's custom stubPath uses the import name, not the distribution name.
const generated = new URL(
  "backend/.wrangler/python-types/js-stubs/__init__.pyi",
  root,
);
const destination = new URL("backend/typings/js/", root);
await mkdir(destination, { recursive: true });
// Preserve generated declarations while removing whitespace that Git flags.
const definitions =
  (await readFile(generated, "utf8")).replace(/[ \t]+$/gm, "").trimEnd() + "\n";
await writeFile(
  new URL("__init__.pyi", destination),
  "# Generated from backend/wrangler.jsonc by npm run types:worker. Do not edit.\n" +
    definitions,
);
