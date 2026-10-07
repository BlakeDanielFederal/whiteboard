import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { isObjectValue } from "@dev.fast/json";
import { writePrivateJsonAtomic } from "@dev.fast/trace-core";
import { findReviewPackageRoot } from "@review/package-paths.js";
import { openReviewProfile } from "@review/review-api/profile.js";
import {
  type ReviewServerDiscovery,
  reviewServerDiscoveryPath,
} from "@review/server-discovery.js";
import type { Context } from "hono";

import { createAskTools } from "./ask-tools.js";
import { GlobalReviewDesktopVerbRelay } from "./global-verb-relay.js";
import { withHeadlessServerLock } from "./headless-host.js";
import { type ReviewHonoEnv, createNodeRequestListener } from "./hono-http.js";
import {
  drainServerCrashReport,
  installProcessErrorTelemetry,
} from "./process-error-telemetry.js";
import { createWhiteboardCore } from "./review-server-core.js";
import type { ReviewTelemetryCapture } from "./ui-telemetry.js";

export interface WebHostInput {
  stateDir: string;
  /** The address to listen on; 0.0.0.0 serves the local network. */
  host: string;
  port: number;
  /** The built browser UI: index.html, the canvas and the diff library. */
  assetsDir: string;
  softwareMapEnabled?: boolean;
  signal: AbortSignal;
  telemetry?: Pick<ReviewTelemetryCapture, "captureUiEvent">;
  onReady(ready: { url: string; discovery: ReviewServerDiscovery }): void;
}

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json"],
  [".map", "application/json"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".woff2", "font/woff2"],
]);

/** Routes the review core owns; the UI never answers for them. */
const API_PREFIXES = ["/reviews-api", "/control", "/health"];

/**
 * Whiteboard for browsers: the review API, Ask and the web UI from one origin,
 * with no login. It holds the same state-directory lock and publishes the same
 * discovery record as `whiteboard server`, so one of them owns a state
 * directory and the CLI and Ask agents on this machine find either.
 */
export async function runWebHost(input: WebHostInput) {
  const assetsDir = await realpath(input.assetsDir).catch(() => {
    throw new Error(`No Whiteboard web UI at ${input.assetsDir}.`);
  });

  if (!(await isFile(path.join(assetsDir, "index.html"))))
    throw new Error(
      `No Whiteboard web UI in ${assetsDir}: index.html is missing.`,
    );

  await mkdir(input.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(input.stateDir);

  const stopErrorTelemetry =
    input.telemetry && installProcessErrorTelemetry(input.telemetry);

  const outcome = await withHeadlessServerLock(stateDir, () =>
    serve({ ...input, stateDir, assetsDir }),
  ).finally(() => stopErrorTelemetry?.());

  if (!outcome.acquired)
    throw new Error(
      `A Whiteboard server already owns ${stateDir}. Stop it first, or choose another --state-dir.`,
    );
}

async function serve(input: WebHostInput) {
  if (input.signal.aborted) return;

  if (input.telemetry) await drainServerCrashReport(input.telemetry);

  // Ask runs in a review's pinned checkout, which only managed workspaces prepare.
  const local = await openReviewProfile(input.stateDir, {
    manageWorkspaces: true,
  });

  const discovery: ReviewServerDiscovery = {
    version: 1,
    instanceId: randomUUID(),
    url: "http://127.0.0.1:0",
    serverPid: process.pid,
    token: randomBytes(32).toString("base64url"),
  };

  const relay = new GlobalReviewDesktopVerbRelay();

  const cliPath = path.join(
    findReviewPackageRoot(import.meta.url),
    "dist",
    "cli.js",
  );

  const core = createWhiteboardCore({
    profile: local,
    relay,
    token: discovery.token,
    access: "open",
    instanceId: discovery.instanceId,
    softwareMapEnabled: input.softwareMapEnabled,
    scratchpad: () => false,
    status: () => ({ key: "web", home: input.stateDir }),
    ask: {
      tools: createAskTools({
        cliPath: () => cliPath,
        // Pins the agents' CLI to this server's state directory.
        env: () => [{ name: "DEV_REVIEW_SERVER_DIR", value: input.stateDir }],
      }),
    },
  });

  core.app.route("/reviews-api", core.api);
  core.app.get("*", (context) => serveAsset(context, input.assetsDir));

  const server = createServer(createNodeRequestListener(core.app));
  let published = false;

  try {
    const listening = once(server, "listening");
    server.listen(input.port, input.host);
    await listening;
    const address = server.address();

    if (!isObjectValue(address))
      throw new Error("Whiteboard server did not bind a TCP port.");
    // The CLI and Ask agents on this machine reach it over loopback.
    discovery.url = `http://127.0.0.1:${address.port}`;
    await writePrivateJsonAtomic(
      reviewServerDiscoveryPath(input.stateDir),
      discovery,
    );
    published = true;
    input.onReady({
      url: `http://${displayHost(input.host)}:${address.port}`,
      discovery,
    });

    await new Promise<void>((resolve) => {
      if (input.signal.aborted) resolve();
      else
        input.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    // Watch streams may live forever. Drain ordinary requests, then bound shutdown.
    const forceClose = setTimeout(() => server.closeAllConnections(), 5_000);
    forceClose.unref();

    try {
      if (published)
        await rm(reviewServerDiscoveryPath(input.stateDir), { force: true });
    } finally {
      relay.close();
      core.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      clearTimeout(forceClose);

      try {
        await local.data.close();
      } finally {
        await local.store.close();
      }
    }
  }
}

/**
 * A file of the web UI, or the UI page itself for any extension-less path so
 * that a review link can be reloaded and bookmarked.
 */
async function serveAsset(context: Context<ReviewHonoEnv>, assetsDir: string) {
  const pathname = decodeURIComponent(new URL(context.req.url).pathname);

  if (API_PREFIXES.some((prefix) => pathname.startsWith(prefix)))
    return context.notFound();

  const file = path.join(assetsDir, path.normalize(pathname));

  if (file !== assetsDir && !file.startsWith(assetsDir + path.sep))
    return context.notFound();

  if (await isFile(file)) return fileResponse(file);

  if (path.extname(pathname)) return context.notFound();

  return fileResponse(path.join(assetsDir, "index.html"));
}

async function fileResponse(file: string): Promise<Response> {
  const type =
    CONTENT_TYPES.get(path.extname(file).toLowerCase()) ??
    "application/octet-stream";

  return new Response(await readFile(file), {
    headers: {
      "content-type": type,
      // The UI page names hashed assets; it must always be fresh.
      "cache-control": file.endsWith("index.html")
        ? "no-cache"
        : "max-age=3600",
    },
  });
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function displayHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "localhost";

  return host.includes(":") ? `[${host}]` : host;
}
