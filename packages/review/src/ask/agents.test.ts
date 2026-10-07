import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { detectAskAgents, launchAskAgent } from "@review/ask/agents.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let bin: string;

beforeEach(async () => {
  bin = await mkdtemp(path.join(tmpdir(), "ask-agents-"));

  // A stand-in Copilot CLI that records how it was started, its arguments last.
  await writeFile(
    path.join(bin, "copilot"),
    '#!/bin/sh\nprintf "%s\\n" "${COPILOT_ALLOW_ALL-unset}" > "$0.allow"\nprintf "%s\\n" "$@" > "$0.args"\n',
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", bin);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(bin, { recursive: true, force: true });
});

/** Starts Copilot as Ask does, and reads back what it was given. */
async function startCopilot(bypass: boolean) {
  const agent = await launchAskAgent("copilot", bin, { bypass });
  const args = path.join(bin, "copilot.args");

  await vi.waitFor(() => readFile(args, "utf8"));
  agent.stop();

  return {
    args: (await readFile(args, "utf8")).trim().split("\n"),
    allowAll: (await readFile(path.join(bin, "copilot.allow"), "utf8")).trim(),
  };
}

it("starts Copilot over ACP refusing file edits, and allows nothing on its own", async () => {
  expect(await startCopilot(false)).toEqual({
    args: ["--acp", "--deny-tool=write"],
    allowAll: "unset",
  });
});

it("lets Copilot edit and run commands without asking when the reviewer bypasses permissions", async () => {
  expect(await startCopilot(true)).toEqual({
    args: ["--acp"],
    allowAll: "1",
  });
});

it("offers Copilot once its CLI is installed, as read-only with a bypass", async () => {
  const copilot = (await detectAskAgents({ PATH: bin })).find(
    (agent) => agent.id === "copilot",
  );

  expect(copilot).toEqual({
    id: "copilot",
    name: "Copilot CLI",
    available: true,
    readOnly: true,
    bypass: true,
  });
});
