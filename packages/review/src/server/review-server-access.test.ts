import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { openReviewProfile } from "@review/review-api/profile.js";
import { afterEach, beforeEach, expect, it } from "vitest";

import { GlobalReviewDesktopVerbRelay } from "./global-verb-relay.js";
import {
  type ReviewServerAccess,
  createWhiteboardCore,
} from "./review-server-core.js";

let root: string;

const stops: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-server-access-"));
});

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  await rm(root, { recursive: true, force: true });
});

async function serve(access?: ReviewServerAccess) {
  const local = await openReviewProfile(root, { manageWorkspaces: false });

  stops.push(async () => {
    await local.data.close();
    await local.store.close();
  });

  const { app, api } = createWhiteboardCore({
    profile: local,
    relay: new GlobalReviewDesktopVerbRelay(),
    token: "secret",
    access,
    instanceId: "instance",
    scratchpad: () => false,
    status: () => ({ key: "test" }),
  });

  app.route("/reviews-api", api);

  return app;
}

it("requires the token by default", async () => {
  const app = await serve();

  expect((await app.request("/reviews-api")).status).toBe(401);
  expect(
    (
      await app.request("/reviews-api", {
        headers: { "x-review-token": "secret" },
      })
    ).status,
  ).toBe(200);
});

it("serves reviews without a token in open mode", async () => {
  const app = await serve("open");

  const response = await app.request("/reviews-api");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([]);
});

it.each([undefined, "open"] as const)(
  "answers /health without a token (access: %s)",
  async (access) => {
    const app = await serve(access);

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  },
);
