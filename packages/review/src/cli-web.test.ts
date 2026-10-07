import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reviewServerDiscoveryPath } from "@review/server-discovery.js";
import { afterEach, beforeEach, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

let root: string;

let assetsDir: string;

const children: ChildProcess[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-cli-web-"));
  assetsDir = path.join(root, "web");
  await mkdir(assetsDir);
  await writeFile(path.join(assetsDir, "index.html"), "<!doctype html>UI");
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }

  await rm(root, { recursive: true, force: true });
});

function web(args: string[], env: Record<string, string> = {}) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "web", ...args],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        DEV_REVIEW_HOME: root,
        DEV_FAST_REVIEW_TELEMETRY_DISABLED: "1",
        DEV_FAST_REVIEW_CLI_NO_DELEGATE: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  children.push(child);
  let stdout = "";

  let stderr = "";

  child.stdout?.on("data", (chunk) => (stdout += chunk));
  child.stderr?.on("data", (chunk) => (stderr += chunk));

  const ready = new Promise<string>((resolve, reject) => {
    child.stdout?.on("data", () => {
      if (/ready at|"web\.ready"/.test(stdout)) resolve(stdout);
    });
    child.once("exit", (code) =>
      reject(new Error(`whiteboard web exited ${code}: ${stderr}`)),
    );
  });

  // A test that expects the process to exit never awaits readiness.
  ready.catch(() => {});

  return {
    child,
    ready,
    output: () => ({ stdout, stderr }),
  };
}

const stateDir = () => path.join(root, "state");

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((address) => address?.family === "IPv4" && !address.internal)?.address;

async function startJson() {
  const server = web([
    "--json",
    "--port",
    "0",
    "--state-dir",
    stateDir(),
    "--assets",
    assetsDir,
  ]);

  return JSON.parse(await server.ready);
}

it("listens on loopback by default", async () => {
  const ready = await startJson();

  expect(ready).toMatchObject({ event: "web.ready", host: "127.0.0.1" });
  expect((await fetch(`${ready.url}/`)).status).toBe(200);
});

it.skipIf(!lanAddress)(
  "is unreachable from this machine's LAN address by default",
  async () => {
    const ready = await startJson();

    const port = new URL(ready.url).port;

    await expect(fetch(`http://${lanAddress}:${port}/`)).rejects.toThrow(
      "fetch failed",
    );
  },
);

it("warns that a LAN address has no authentication", async () => {
  const server = web([
    "--host",
    "0.0.0.0",
    "--port",
    "0",
    "--state-dir",
    stateDir(),
    "--assets",
    assetsDir,
  ]);

  await server.ready;

  expect(server.output().stdout).toContain("no authentication");
  expect(server.output().stdout).toContain("run Ask agents");
});

it("stays quiet about authentication on loopback", async () => {
  const server = web([
    "--port",
    "0",
    "--state-dir",
    stateDir(),
    "--assets",
    assetsDir,
  ]);

  await server.ready;

  expect(server.output().stdout).not.toContain("no authentication");
});

it("exits cleanly on SIGTERM and withdraws its discovery record", async () => {
  const server = web(["--port", "0", "--state-dir", stateDir()], {
    WHITEBOARD_WEB_ASSETS: assetsDir,
  });

  await server.ready;
  await stat(reviewServerDiscoveryPath(stateDir()));

  const exit = once(server.child, "exit");

  server.child.kill("SIGTERM");

  const [code] = await exit;

  expect(code).toBe(0);
  await expect(stat(reviewServerDiscoveryPath(stateDir()))).rejects.toThrow(
    "ENOENT",
  );
});

it("asks for the web UI when none is named", async () => {
  const server = web(["--port", "0", "--state-dir", stateDir()], {
    WHITEBOARD_WEB_ASSETS: "",
  });

  const [code] = await once(server.child, "exit");

  expect(code).not.toBe(0);
  expect(server.output().stderr).toContain("--assets");
});
