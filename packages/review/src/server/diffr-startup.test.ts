import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { openLocalReviewStore } from "@review/review-api/local-data.js";
import { parse } from "smol-toml";
import { afterEach, expect, test, vi } from "vitest";

import { createGlobalReviewServer } from "./desktop-server.js";
import { runHeadlessServer } from "./headless-host.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test.each(["desktop", "headless"] as const)(
  "%s startup migrates saved settings before ready and skips migration on restart",
  async (host) => {
    const root = await mkdtemp(path.join(tmpdir(), "review-diffr-startup-"));
    roots.push(root);
    vi.stubEnv("DEV_REVIEW_HOME", root);
    vi.stubEnv("XDG_CONFIG_HOME", root);
    vi.stubEnv("DEV_FAST_REVIEW_TELEMETRY_DISABLED", "1");
    const file = path.join(root, "diffr", "config.toml");
    await mkdir(path.dirname(file));
    await writeFile(
      file,
      "version = 1\n[plugins.bundled.context]\nlines = 17\nenabled = false\n",
    );
    const executable = path.join(root, "diffr-cli");
    const log = path.join(root, "validations");
    await writeFile(
      executable,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME, 'diffr', 'config.toml'), 'utf8');
if (!/version = 2/.test(source)) process.exit(2);
fs.appendFileSync(${JSON.stringify(log)}, 'validated\\n');
console.log('{}');
`,
      { mode: 0o755 },
    );
    vi.stubEnv("REVIEW_DIFFR_BINARY", executable);

    const ready = async () => {
      expect(parse(await readFile(file, "utf8"))).toMatchObject({
        version: 2,
        // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config key.
        shape: { context: { lines: 17, enabled: false } },
      });
    };

    const start = async () => {
      let configAtReady: string | undefined;

      if (host === "headless") {
        const controller = new AbortController();

        const running = runHeadlessServer({
          stateDir: path.join(root, "server"),
          signal: controller.signal,
          onReady: () => {
            configAtReady = readFileSync(file, "utf8");
            controller.abort();
          },
        });

        await running;
        await ready();
      } else {
        const local = openLocalReviewStore(path.join(root, "reviews.db"));

        const server = createGlobalReviewServer({
          reviewStore: local.store,
          reviewData: local.data,
          appPid: process.pid,
          packageRoot: root,
          toolingRoot: root,
          port: 0,
        });

        try {
          await server.listen();
          configAtReady = readFileSync(file, "utf8");
          await ready();
        } finally {
          await server.close();
          await local.data.close();
          await local.store.close();
        }
      }

      expect(parse(configAtReady!)).toMatchObject({ version: 2 });
    };

    await start();
    await start();
    expect(await readFile(log, "utf8")).toBe("validated\n");
  },
);
