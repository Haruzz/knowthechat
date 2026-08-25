import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const uvVersion = "0.12.5";
const uvBinDirectory = join(homedir(), ".local", "bin");
const localUv = join(
  uvBinDirectory,
  process.platform === "win32" ? "uv.exe" : "uv",
);

function canRun(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} stopped with signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

let uvCommand;
if (canRun("uv")) uvCommand = "uv";
else if (existsSync(localUv)) uvCommand = localUv;
else if (process.platform === "linux") {
  console.log(
    `uv ${uvVersion} is missing; installing it for this Linux build environment.`,
  );
  const response = await fetch(`https://astral.sh/uv/${uvVersion}/install.sh`);
  if (!response.ok)
    throw new Error(`Unable to download uv installer: HTTP ${response.status}`);

  const installer = spawn("sh", [], {
    env: { ...process.env, UV_UNMANAGED_INSTALL: uvBinDirectory },
    stdio: ["pipe", "inherit", "inherit"],
  });
  installer.stdin.end(await response.text());
  const installCode = await new Promise((resolve, reject) => {
    installer.once("error", reject);
    installer.once("exit", (code) => resolve(code ?? 1));
  });
  if (installCode !== 0) process.exit(installCode);
  uvCommand = localUv;
} else {
  console.error("uv is required but was not found on PATH.");
  console.error(
    "Install uv from https://docs.astral.sh/uv/getting-started/installation/ and retry.",
  );
  process.exit(127);
}

process.exit(await run(uvCommand, process.argv.slice(2)));
