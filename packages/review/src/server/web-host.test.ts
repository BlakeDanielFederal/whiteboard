import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectReviewApi } from "@review/review-api/agent-client.js";
import { runHeadlessServer } from "@review/server/headless-host.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { runWebHost } from "./web-host.js";

let root: string;

let assetsDir: string;

const stops: (() => Promise<void>)[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-web-host-"));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  vi.stubEnv("DEV_FAST_REVIEW_TELEMETRY_DISABLED", "1");
  assetsDir = path.join(root, "web");
  await mkdir(path.join(assetsDir, "assets"), { recursive: true });
  await writeFile(path.join(assetsDir, "index.html"), "<!doctype html>UI");
  await writeFile(path.join(assetsDir, "assets", "canvas.js"), "export {};");
  await writeFile(path.join(root, "secret.txt"), "outside the UI");
});

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function start(stateDir = path.join(root, "state")) {
  const controller = new AbortController();
  const ready = Promise.withResolvers<{ url: string }>();

  const running = runWebHost({
    stateDir,
    host: "127.0.0.1",
    port: 0,
    assetsDir,
    signal: controller.signal,
    onReady: ({ discovery }) => ready.resolve({ url: discovery.url }),
  });

  const stop = async () => {
    controller.abort();
    await running;
  };

  stops.push(stop);

  const { url } = await Promise.race([
    ready.promise,
    running.then(() => {
      throw new Error("Web host exited before readiness");
    }),
  ]);

  return { url, stateDir, running, stop };
}

it("serves the UI page for a review link, and its assets", async () => {
  const { url } = await start();

  const page = await fetch(
    `${url}/reviews/6dcbc266-3af3-45cb-9032-8f85ffde4de0`,
  );

  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toBe("<!doctype html>UI");

  const script = await fetch(`${url}/assets/canvas.js`);

  expect(script.headers.get("content-type")).toContain("text/javascript");
});

it("serves the review API without a token", async () => {
  const { url } = await start();

  const reviews = await fetch(`${url}/reviews-api`);

  expect(reviews.status).toBe(200);
  expect(await reviews.json()).toEqual([]);
});

it("offers no desktop-only routes, and never answers the API with the UI", async () => {
  const { url } = await start();

  expect((await fetch(`${url}/install/apply`, { method: "POST" })).status).toBe(
    404,
  );
  expect((await fetch(`${url}/reviews-api/missing/route`)).status).toBe(404);
  expect((await fetch(`${url}/assets/missing.js`)).status).toBe(404);
});

it("never serves a file outside the UI directory", async () => {
  const { url } = await start();

  const response = await fetch(`${url}/%2e%2e/secret.txt`);

  expect(await response.text()).not.toContain("outside the UI");
});

it("lets the CLI on this machine find it through the state directory", async () => {
  const { stateDir } = await start();

  const client = await connectReviewApi({
    ...process.env,
    DEV_REVIEW_SERVER_DIR: stateDir,
  });

  expect(await client.read("")).toEqual([]);
});

it("refuses a state directory another server already owns", async () => {
  const stateDir = path.join(root, "shared");

  const headless = new AbortController();
  const ready = Promise.withResolvers<void>();

  const running = runHeadlessServer({
    stateDir,
    signal: headless.signal,
    onReady: () => ready.resolve(),
  });

  stops.push(async () => {
    headless.abort();
    await running;
  });
  await ready.promise;

  await expect(
    runWebHost({
      stateDir,
      host: "127.0.0.1",
      port: 0,
      assetsDir,
      signal: new AbortController().signal,
      onReady: () => {},
    }),
  ).rejects.toThrow(`already owns`);
});

it("refuses to start without the UI page", async () => {
  await rm(path.join(assetsDir, "index.html"));

  await expect(
    runWebHost({
      stateDir: path.join(root, "state"),
      host: "127.0.0.1",
      port: 0,
      assetsDir,
      signal: new AbortController().signal,
      onReady: () => {},
    }),
  ).rejects.toThrow("index.html is missing");
});
