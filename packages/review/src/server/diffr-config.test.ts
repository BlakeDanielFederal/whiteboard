import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonObject } from "@dev.fast/json";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  readDiffrConfig,
  saveDiffrSummarizer,
  setDiffrConfigValue,
  testDiffrSummarizer,
} from "./diffr-config";
import { StructuralComparisons } from "./structural-comparisons";

const roots: string[] = [];

beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GOOGLE_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("MISTRAL_API_KEY", "");
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const DEFAULT_PROMPT = "Summarize each fold.";

// What diffr's schema says about each provider. "mistral" exists only here:
// Whiteboard must handle a provider it has never heard of.
const PROVIDERS = [
  [
    "gemini",
    "Gemini",
    "gemini-3.8-flash",
    "https://generativelanguage.googleapis.com",
    ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    false,
  ],
  [
    "openai",
    "OpenAI",
    "gpt-6-luna",
    "https://api.openai.com/v1",
    ["OPENAI_API_KEY"],
    true,
  ],
  [
    "anthropic",
    "Anthropic",
    "claude-haiku-4-5",
    "https://api.anthropic.com",
    ["ANTHROPIC_API_KEY"],
    false,
  ],
  [
    "mistral",
    "Mistral",
    "mistral-small",
    "https://api.mistral.ai/v1",
    ["MISTRAL_API_KEY"],
    false,
  ],
] as const;

const SUMMARIZE_SCHEMA = {
  type: "object",
  properties: {
    provider: {
      enum: PROVIDERS.map(([id]) => id),
      "x-enum-titles": PROVIDERS.map(([, title]) => title),
    },
    model: {
      type: "string",
      "x-default-by": {
        key: "provider",
        values: Object.fromEntries(
          PROVIDERS.map(([id, , model]) => [id, model]),
        ),
      },
    },
    provider_details: {
      type: "object",
      "x-default-by": {
        key: "provider",
        values: Object.fromEntries(
          PROVIDERS.map(([id, , , endpoint, keys, keyless]) => [
            id,
            { endpoint, key_variables: keys, keyless_custom_endpoint: keyless },
          ]),
        ),
      },
    },
    system_prompt: {
      type: "string",
      default: DEFAULT_PROMPT,
    },
  },
};

const draft = {
  enabled: true,
  provider: "gemini" as const,
  model: "test-model",
  endpoint: "",
  systemPrompt: DEFAULT_PROMPT,
  tests: true,
};

async function fakeDiffr(
  key = "",
  summarize: JsonObject = {},
  classifier?: JsonObject,
) {
  const root = await mkdtemp(path.join(tmpdir(), "review-diffr-config-"));
  roots.push(root);

  const log = path.join(root, "calls.jsonl"),
    state = path.join(root, "state.json"),
    file = path.join(root, "diffr");

  await writeFile(
    state,
    JSON.stringify({
      version: 2,
      plugins: {
        ...(classifier && { classify: { bundled: classifier } }),
        // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config key.
        shape: {
          bundled: {
            summarize: {
              enabled: false,
              provider: "gemini",
              model: "old",
              tests: false,
              system_prompt: DEFAULT_PROMPT,
              ...(key && { api_key: key }),
              ...summarize,
            },
            context: { lines: 3, enabled: true },
          },
        },
      },
    }),
  );
  await writeFile(
    file,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = ${JSON.stringify(state)}, log = ${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
const config = JSON.parse(fs.readFileSync(state, 'utf8'));
if (args[0] === 'config' && args[1] === 'schema' && process.env.FAIL_SCHEMA) {
  process.exit(2);
} else if (args[0] === 'config' && args[1] === 'schema') {
  const summarize = ${JSON.stringify(SUMMARIZE_SCHEMA)};
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config key.
  console.log(JSON.stringify({ properties: { plugins: { properties: { ${classifier ? 'classify: { properties: { bundled: { properties: { hide: { default: ["generated", "vendored"] } } } } },' : ""} shape: { properties: { bundled: { properties: { summarize } } } } } } } }));
} else if (args[0] === 'config' && args[1] === 'show') {
  if (!args.includes('--reveal') && config.plugins.shape.bundled.summarize.api_key) config.plugins.shape.bundled.summarize.api_key = '<redacted>';
  console.log(JSON.stringify(config));
} else if (args[0] === 'config' && args[1] === 'set') {
  if (args[2] === process.env.FAIL_KEY) { console.error('command leaked secret: ' + args.join(' ')); process.exit(2); }
  const keys = args[2].split('.'); let object = config;
  for (const part of keys.slice(0,-1)) object = object[part];
  let value = args[3]; try { value = JSON.parse(value); } catch {}
  // diffr clears a provider's own settings when the provider changes.
  if (process.env.FAKE_RESET && args[2].endsWith('.provider') && object.provider !== value) {
    for (const option of ['api_key', 'endpoint', 'model']) delete object[option];
  }
  object[keys.at(-1)] = value;
  fs.writeFileSync(state, JSON.stringify(config));
 } else if (!args.includes('--no-index')) {
  console.log(JSON.stringify({type:'start',version:3,lhs:{type:'revision',rev:'base'},rhs:{type:'revision',rev:'head'},files:[]}));
  console.log(JSON.stringify({type:'complete',succeeded:0,failed:0}));
} else {
  const temporary = require('node:path').join(process.env.XDG_CONFIG_HOME, 'diffr', 'config.toml');
  fs.writeFileSync(${JSON.stringify(path.join(root, "test-config"))}, fs.readFileSync(temporary));
  fs.writeFileSync(${JSON.stringify(path.join(root, "test-path"))}, temporary);
  const mode = process.env.TEST_MODE;
  fs.writeFileSync(${JSON.stringify(path.join(root, "test-env"))}, JSON.stringify({ gemini: process.env.GEMINI_API_KEY, openai: process.env.OPENAI_API_KEY }));
  if (mode === 'reject') { console.error(process.env.GEMINI_API_KEY); process.exit(2); }
  if (mode === 'hang') { setTimeout(() => {}, 10000); }
  else {
    const file = {rhs:{path:'after.rs',oid:'',mode:''}};
    console.log(JSON.stringify({type:'file',file,diff:{type:'text',rhs:{text:'sample',root:{kind:'leaf',id:1,fold_state_id:1,alignment_id:1,start:{line:0,column:0},end:{line:0,column:6},visibility:mode === 'empty' ? undefined : {collapsed:true,label:'count positive values'}}},structural_changes:{base:[],head:[[0,1]]},stats:{textual:{added:1,removed:0},visible:{added:0,removed:0}}}}));
    console.log(JSON.stringify({type:'complete',succeeded:1,failed:0}));
  }
}
`,
    { mode: 0o755 },
  );
  vi.stubEnv("REVIEW_DIFFR_BINARY", file);

  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "xdg"));

  return {
    root,
    state,
    calls: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
  };
}

test("reads resolved values and reports credentials without exposing keys", async () => {
  await fakeDiffr("saved-secret");
  vi.stubEnv("GEMINI_API_KEY", "env-secret");
  const config = await readDiffrConfig();
  expect(config.credentialSource).toBe("config");
  expect(JSON.stringify(config)).not.toMatch(
    /saved-secret|env-secret|redacted|api_key/,
  );
});

test("redacts credentials in bundled and custom shape entries", async () => {
  const fake = await fakeDiffr("bundled-secret");
  const state = JSON.parse(await readFile(fake.state, "utf8"));
  state.plugins.shape.custom = {
    path: "plugins/custom",
    api_key: "custom-secret",
    enabled: true,
  };
  await writeFile(fake.state, JSON.stringify(state));

  const config = await readDiffrConfig();
  expect(JSON.stringify(config)).not.toMatch(
    /bundled-secret|custom-secret|api_key/,
  );
  expect(config.values).toMatchObject({
    plugins: {
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config key.
      shape: { custom: { path: "plugins/custom", enabled: true } },
    },
  });
});

test("detects host environment credentials and missing credentials", async () => {
  await fakeDiffr();
  expect((await readDiffrConfig()).credentialSource).toBe("missing");
  vi.stubEnv("GOOGLE_API_KEY", "environment-secret");
  expect((await readDiffrConfig()).credentialSource).toBe("environment");
});

test("reads classifier values and schema defaults without old plugin keys", async () => {
  await fakeDiffr(
    "saved-secret",
    {},
    { hide: ["test", "custom"], hide_deleted: false },
  );
  const config = await readDiffrConfig();
  expect(config.values).toMatchObject({
    plugins: {
      classify: { bundled: { hide: ["test", "custom"], hide_deleted: false } },
    },
  });
  expect(config.defaultHiddenTags).toEqual(["generated", "vendored"]);
  expect(JSON.stringify(config)).not.toContain("saved-secret");
});

test("writes classifier values without changing credentials", async () => {
  const fake = await fakeDiffr(
    "saved-secret",
    {},
    { hide: ["custom"], hide_deleted: true },
  );

  expect(
    (await setDiffrConfigValue("plugins.classify.bundled.hide", ["custom"]))
      .changed,
  ).toBe(false);
  await setDiffrConfigValue("plugins.classify.bundled.hide", []);
  await setDiffrConfigValue("plugins.classify.bundled.hide_deleted", false);
  const disabled = JSON.parse(await readFile(fake.state, "utf8"));
  expect(disabled.plugins.classify.bundled).toEqual({
    hide: [],
    hide_deleted: false,
  });
  await setDiffrConfigValue("plugins.classify.bundled.hide", ["custom"]);
  const enabled = JSON.parse(await readFile(fake.state, "utf8"));
  expect(enabled.plugins.classify.bundled).toEqual({
    hide: ["custom"],
    hide_deleted: false,
  });
  expect(enabled.plugins.shape.bundled.summarize.api_key).toBe("saved-secret");
  expect(enabled.plugins.shape.bundled["hide-files"]).toBeUndefined();
});

test("writes the native path of a custom classifier whose name contains spaces", async () => {
  const fake = await fakeDiffr("saved-secret", {}, { hide: ["team"] });
  const state = JSON.parse(await readFile(fake.state, "utf8"));
  state.plugins.classify = {
    "team classifier": state.plugins.classify.bundled,
  };
  await writeFile(fake.state, JSON.stringify(state));

  const result = await setDiffrConfigValue(
    "plugins.classify.team classifier.hide",
    [],
  );

  expect(result.error).toBeUndefined();
  expect(result.values).toMatchObject({
    plugins: { classify: { "team classifier": { hide: [] } } },
  });
  const saved = JSON.parse(await readFile(fake.state, "utf8"));
  expect(Object.keys(saved.plugins.classify)).toEqual(["team classifier"]);
  expect(JSON.stringify(result)).not.toContain("saved-secret");
});

test("writes a setting, rereads it, and avoids invalidation for a no-op", async () => {
  await fakeDiffr();
  expect(
    (await setDiffrConfigValue("plugins.shape.bundled.context.lines", 3))
      .changed,
  ).toBe(false);

  const result = await setDiffrConfigValue(
    "plugins.shape.bundled.context.lines",
    8,
  );

  expect(result).toMatchObject({
    changed: true,
    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config key.
    values: { plugins: { shape: { bundled: { context: { lines: 8 } } } } },
  });
});

test("saves credentials and options before enabling and preserves blank keys", async () => {
  const fake = await fakeDiffr();
  await saveDiffrSummarizer({ ...draft, apiKey: "test-secret" });
  const writes = (await fake.calls()).filter((args) => args[1] === "set");
  expect(writes.map((args) => args[2])).toEqual(
    ["api_key", "model", "tests", "enabled"].map(
      (key) => `plugins.shape.bundled.summarize.${key}`,
    ),
  );
  await saveDiffrSummarizer({ ...draft, apiKey: "" });
  expect(
    JSON.parse(await readFile(fake.state, "utf8")).plugins.shape.bundled
      .summarize.api_key,
  ).toBe("test-secret");
});

test("disables first and serializes concurrent saves", async () => {
  const fake = await fakeDiffr("test-secret");
  await saveDiffrSummarizer(draft);
  await Promise.all([
    saveDiffrSummarizer({ ...draft, enabled: false, model: "next" }),
    setDiffrConfigValue("plugins.shape.bundled.context.lines", 9),
  ]);

  const writes = (await fake.calls())
    .filter((args) => args[1] === "set")
    .slice(-3);

  expect(writes.map((args) => args[2])).toEqual([
    "plugins.shape.bundled.summarize.enabled",
    "plugins.shape.bundled.summarize.model",
    "plugins.shape.bundled.context.lines",
  ]);
});

test("partial failure returns current values and invalidates without leaking the key", async () => {
  await fakeDiffr();
  vi.stubEnv("FAIL_KEY", "plugins.shape.bundled.summarize.model");
  const result = await saveDiffrSummarizer({ ...draft, apiKey: "test-secret" });
  expect(result.changed).toBe(true);
  expect(result.error).toContain("Some settings were saved");
  expect(result.values).toMatchObject({
    plugins: {
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config key.
      shape: { bundled: { summarize: { enabled: false, model: "old" } } },
    },
  });
  expect(JSON.stringify(result)).not.toContain("test-secret");
});

test("failed key saves do not leak args or stderr and do not invalidate", async () => {
  await fakeDiffr();
  vi.stubEnv("FAIL_KEY", "plugins.shape.bundled.summarize.api_key");
  const result = await saveDiffrSummarizer({ ...draft, apiKey: "test-secret" });
  expect(result.changed).toBe(false);
  expect(result.error).toBeDefined();
  expect(JSON.stringify(result)).not.toMatch(/test-secret|command leaked/);
});

test("cannot enable summaries without credentials", async () => {
  await fakeDiffr();
  expect(await saveDiffrSummarizer(draft)).toMatchObject({
    changed: false,
    error: expect.stringContaining("API key"),
  });
});

test("synthetic test returns a summary without saving and cleans its config", async () => {
  const fake = await fakeDiffr("saved-secret");
  const before = await readFile(fake.state, "utf8");
  expect(await testDiffrSummarizer(draft)).toBe("count positive values");
  expect(await readFile(fake.state, "utf8")).toBe(before);
  expect(
    await readFile(path.join(fake.root, "test-config"), "utf8"),
  ).not.toContain("saved-secret");
  await expect(
    readFile(await readFile(path.join(fake.root, "test-path"), "utf8")),
  ).rejects.toThrow("ENOENT");
});

test("rejected credentials and empty summaries are safe failures with cleanup", async () => {
  const fake = await fakeDiffr();
  vi.stubEnv("TEST_MODE", "reject");
  await expect(
    testDiffrSummarizer({ ...draft, apiKey: "test-secret" }),
  ).rejects.toThrow("Check its configuration and credentials");
  await expect(
    readFile(await readFile(path.join(fake.root, "test-path"), "utf8")),
  ).rejects.toThrow("ENOENT");
  vi.stubEnv("TEST_MODE", "empty");
  await expect(
    testDiffrSummarizer({ ...draft, apiKey: "test-secret" }),
  ).rejects.toThrow("No summary was produced");
});

test("a cancelled test cleans temporary files and releases the single-test guard", async () => {
  const fake = await fakeDiffr("test-secret");
  vi.stubEnv("TEST_MODE", "hang");
  const controller = new AbortController();

  const cancelled = testDiffrSummarizer(
    draft,
    undefined,
    controller.signal,
  ).catch((error) => error);

  try {
    await expect
      .poll(
        () =>
          readFile(path.join(fake.root, "test-path"), "utf8").catch(() => ""),
        { timeout: 5_000 },
      )
      .not.toBe("");
  } finally {
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({
      message: expect.stringContaining("timed out or was cancelled"),
    });
  }

  await expect(
    readFile(await readFile(path.join(fake.root, "test-path"), "utf8")),
  ).rejects.toThrow("ENOENT");
  vi.stubEnv("TEST_MODE", "");
  expect(await testDiffrSummarizer(draft)).toBe("count positive values");
});

test("rejects malformed keys and reports missing executables", async () => {
  await expect(async () => setDiffrConfigValue("--flag", true)).rejects.toThrow(
    "Invalid diffr config key",
  );
  vi.stubEnv("REVIEW_DIFFR_BINARY", "/nonexistent/diffr");
  await expect(readDiffrConfig()).rejects.toThrow("Cannot find diffr");
});

test("saved changes invalidate cached comparisons while no-op saves reuse them", async () => {
  const fake = await fakeDiffr();
  const cache = new StructuralComparisons();

  const input = {
    repositoryPath: fake.root,
    comparison: { kind: "trees" as const, base: "base", head: "head" },
    signal: new AbortController().signal,
  };

  async function consume() {
    for await (const event of cache.stream(input))
      expect(event.type).toMatch(/start|complete/);
  }

  try {
    await consume();
    await setDiffrConfigValue("plugins.shape.bundled.context.lines", 3);
    await consume();
    expect(
      (await fake.calls()).filter((args) => args[0] === "--repo"),
    ).toHaveLength(1);
    await setDiffrConfigValue("plugins.shape.bundled.context.lines", 8);
    await consume();
    expect(
      (await fake.calls()).filter((args) => args[0] === "--repo"),
    ).toHaveLength(2);
  } finally {
    cache.close();
  }
});

test("reads the default prompt from diffr's schema", async () => {
  await fakeDiffr();
  expect(await readDiffrConfig()).toMatchObject({
    defaultPrompt: DEFAULT_PROMPT,
  });
});

test("saves a changed prompt and leaves an unchanged one alone", async () => {
  const fake = await fakeDiffr("test-secret");
  await saveDiffrSummarizer({ ...draft, enabled: false });
  expect(
    (await fake.calls()).some((args) => args[2]?.endsWith(".system_prompt")),
  ).toBe(false);
  await saveDiffrSummarizer({
    ...draft,
    enabled: false,
    systemPrompt: "Be terse.",
  });
  expect(
    JSON.parse(await readFile(fake.state, "utf8")).plugins.shape.bundled
      .summarize.system_prompt,
  ).toBe("Be terse.");
});

test("switching providers clears the saved key unless a new one is entered", async () => {
  const fake = await fakeDiffr("gemini-secret");

  const state = async () =>
    JSON.parse(await readFile(fake.state, "utf8")).plugins.shape.bundled
      .summarize;

  await saveDiffrSummarizer({
    ...draft,
    enabled: false,
    provider: "anthropic",
  });
  expect(await state()).toMatchObject({ provider: "anthropic", api_key: "" });
  await saveDiffrSummarizer({
    ...draft,
    enabled: false,
    provider: "openai",
    apiKey: "openai-secret",
  });
  expect(await state()).toMatchObject({
    provider: "openai",
    api_key: "openai-secret",
  });
});

test("credentials are checked against the draft provider", async () => {
  await fakeDiffr("gemini-secret");
  expect(
    await saveDiffrSummarizer({ ...draft, provider: "anthropic" }),
  ).toMatchObject({
    changed: false,
    error: expect.stringContaining("API key"),
  });
  vi.stubEnv("ANTHROPIC_API_KEY", "env-secret");
  expect(
    (await saveDiffrSummarizer({ ...draft, provider: "anthropic" })).error,
  ).toBeUndefined();
  expect(
    (
      await saveDiffrSummarizer({
        ...draft,
        provider: "openai",
        endpoint: "http://127.0.0.1:11434/v1",
      })
    ).error,
  ).toBeUndefined();
});

test("the synthetic test never sends a saved key to another provider and uses the draft prompt", async () => {
  const fake = await fakeDiffr("gemini-secret");
  await expect(
    testDiffrSummarizer({ ...draft, provider: "openai" }),
  ).rejects.toThrow("Add an API key");
  vi.stubEnv("OPENAI_API_KEY", "env-openai");
  expect(
    await testDiffrSummarizer({
      ...draft,
      provider: "openai",
      systemPrompt: "Draft prompt.",
    }),
  ).toBe("count positive values");
  expect(
    JSON.parse(await readFile(path.join(fake.root, "test-env"), "utf8")),
  ).toEqual({ gemini: "", openai: "env-openai" });
  const config = await readFile(path.join(fake.root, "test-config"), "utf8");
  expect(config).toContain('provider = "openai"');
  expect(config).toContain("Draft prompt.");
});

test("reads the environment key of the saved provider", async () => {
  await fakeDiffr();
  await saveDiffrSummarizer({
    ...draft,
    enabled: false,
    provider: "anthropic",
  });
  vi.stubEnv("GEMINI_API_KEY", "gemini-env");
  expect((await readDiffrConfig()).credentialSource).toBe("missing");
  vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-env");
  expect((await readDiffrConfig()).credentialSource).toBe("environment");
});

test("a switch clears the saved key before naming the new provider", async () => {
  const fake = await fakeDiffr("gemini-secret");
  vi.stubEnv("FAIL_KEY", "plugins.shape.bundled.summarize.provider");

  const result = await saveDiffrSummarizer({
    ...draft,
    provider: "openai",
    apiKey: "openai-secret",
  });

  expect(result.error).toBeDefined();

  const state = JSON.parse(await readFile(fake.state, "utf8")).plugins.shape
    .bundled.summarize;

  // The failure left the old provider, and no key for it to send.
  expect(state).toMatchObject({ provider: "gemini", api_key: "" });
});

test("a new endpoint is treated like a new provider", async () => {
  const fake = await fakeDiffr("saved-secret");
  const moved = { ...draft, endpoint: "https://proxy.example/v1" };
  await expect(testDiffrSummarizer(moved)).rejects.toThrow("Add an API key");
  await saveDiffrSummarizer({ ...moved, enabled: false });
  expect(
    JSON.parse(await readFile(fake.state, "utf8")).plugins.shape.bundled
      .summarize,
  ).toMatchObject({ api_key: "", endpoint: "https://proxy.example/v1" });
});

test("a switch with no saved key writes no empty key", async () => {
  const fake = await fakeDiffr();
  await saveDiffrSummarizer({
    ...draft,
    enabled: false,
    provider: "anthropic",
  });
  expect(
    (await fake.calls()).some((args) => args[2]?.endsWith(".api_key")),
  ).toBe(false);
});

test("settings still read when diffr describes no schema", async () => {
  await fakeDiffr();
  vi.stubEnv("FAIL_SCHEMA", "1");
  const config = await readDiffrConfig();
  expect(config.defaultPrompt).toBeUndefined();
  expect(config.values).toBeDefined();
});

test("a saved prompt is compared as written and a blank one is left alone", async () => {
  const fake = await fakeDiffr("", { system_prompt: "Custom.\n" });
  await saveDiffrSummarizer({
    ...draft,
    enabled: false,
    systemPrompt: "Custom.\n",
  });
  await saveDiffrSummarizer({ ...draft, enabled: false, systemPrompt: "" });
  expect(
    (await fake.calls()).some((args) => args[2]?.endsWith(".system_prompt")),
  ).toBe(false);
});

test("providers, their titles, models and keys all come from diffr's schema", async () => {
  await fakeDiffr();
  const config = await readDiffrConfig();
  expect(config.providers).toContainEqual({
    id: "mistral",
    title: "Mistral",
    model: "mistral-small",
    endpoint: "https://api.mistral.ai/v1",
    keyVariables: ["MISTRAL_API_KEY"],
    keylessCustomEndpoint: false,
  });
  expect(
    (await saveDiffrSummarizer({ ...draft, provider: "mistral" })).error,
  ).toContain("API key");
  vi.stubEnv("MISTRAL_API_KEY", "mistral-env");
  expect(
    (await saveDiffrSummarizer({ ...draft, provider: "mistral" })).error,
  ).toBeUndefined();
});

test("the synthetic test lets diffr derive the draft provider's details", async () => {
  const fake = await fakeDiffr("", {
    provider_details: {
      endpoint: "https://generativelanguage.googleapis.com",
      key_variables: ["GEMINI_API_KEY"],
      keyless_custom_endpoint: false,
    },
  });

  vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
  await testDiffrSummarizer({ ...draft, provider: "anthropic" });
  expect(
    await readFile(path.join(fake.root, "test-config"), "utf8"),
  ).not.toContain("provider_details");
});

test("a custom endpoint kept across a provider switch survives diffr clearing it", async () => {
  const fake = await fakeDiffr();
  vi.stubEnv("FAKE_RESET", "1");

  const gateway = {
    ...draft,
    enabled: false,
    endpoint: "https://gateway.example/v1",
  };

  await saveDiffrSummarizer({
    ...gateway,
    provider: "anthropic",
    apiKey: "anthropic-key",
  });
  await saveDiffrSummarizer({
    ...gateway,
    provider: "openai",
    apiKey: "openai-key",
  });
  expect(
    JSON.parse(await readFile(fake.state, "utf8")).plugins.shape.bundled
      .summarize,
  ).toMatchObject({
    provider: "openai",
    endpoint: "https://gateway.example/v1",
    api_key: "openai-key",
  });
});
