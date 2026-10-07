import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse } from "smol-toml";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";

import {
  ensureDiffrConfigMigrated,
  migrateDiffrConfig,
} from "./diffr-config-migration";
import { TomlEdits } from "./toml-edits";

const roots: string[] = [];

test("rejects a change to a retained credential without exposing its value", () => {
  const original = 'plugins.bundled.summarize.api_key = "saved-secret"\n';
  const edits = new TomlEdits(original);
  edits.set("plugins.bundled.summarize.api_key", "different-secret");
  expect(() =>
    edits.assertUnchanged(original, [
      [
        "plugins.bundled.summarize.api_key",
        "plugins.bundled.summarize.api_key",
      ],
    ]),
  ).toThrow(
    "diffr migration changed a retained setting: plugins.bundled.summarize.api_key",
  );
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("converts a saved UI config without changing supported overrides or their comments", async () => {
  const source = await readFile(
    new URL("./test-fixtures/diffr-ui-overrides.toml", import.meta.url),
    "utf8",
  );

  const migrated = migrateDiffrConfig(source);
  const original = parse(source);
  const expected = structuredClone(original);

  const plugins = z
    .object({
      bundled: z.record(
        z.string(),
        z.record(
          z.string(),
          z.union([z.string(), z.boolean(), z.number(), z.array(z.string())]),
        ),
      ),
    })
    .parse(expected.plugins);

  delete plugins.bundled.group;
  delete plugins.bundled["hide-files"];
  delete plugins.bundled.summarize.max_concurrency;
  expected.version = 2;
  expected.plugins = {
    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config namespace.
    shape: { bundled: plugins.bundled },
    classify: {
      bundled: { hide: ["test", "generated"], hide_deleted: false },
    },
  };
  expect(parse(migrated)).toEqual(expected);

  // Source spans for credentials, prompt, context and fold choices are not serialized.
  for (const line of source
    .split("\n")
    .filter((line) =>
      /# (Collapse|Context|Enable|Provider|API key|Model|Endpoint|Include|Unrelated)/.test(
        line,
      ),
    ))
    expect(migrated).toContain(line);
  expect(migrated).toContain(
    "system_prompt = '''  Use my exact custom instructions.\nKeep # inside the prompt, and answer with JSON if I ask for it.\n''' # Prompt",
  );
  expect(migrated).toContain("# Group adjacent folds; retired");
  expect(migrateDiffrConfig(migrated)).toBe(migrated);
});

test.each([
  [true, true, ["test", "generated"], true],
  [true, false, ["test", "generated"], false],
  [false, true, [], false],
  [false, false, [], false],
])(
  "preserves hiding for enabled=%s deleted=%s",
  (enabled, deleted, hide, hideDeleted) => {
    const migrated = migrateDiffrConfig(
      `[plugins.bundled.hide-files]\nenabled = ${enabled}\ndeleted = ${deleted}\ntags = ["test", "generated"]\n`,
    );

    expect(parse(migrated).plugins).toEqual({
      classify: {
        bundled: {
          hide,
          hide_deleted: hideDeleted,
        },
      },
    });
  },
);

test.each([true, false])(
  "removes retired group=%s without changing context",
  (enabled) => {
    const migrated = migrateDiffrConfig(
      `[plugins.bundled.context]\nenabled = false\nlines = 9\n[plugins.bundled.group]\nenabled = ${enabled}\n`,
    );

    expect(parse(migrated)).toEqual({
      version: 2,
      plugins: {
        // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config namespace.
        shape: { bundled: { context: { enabled: false, lines: 9 } } },
      },
    });
  },
);

test("handles quoted keys, inline tables and dotted keys without touching a custom prompt", () => {
  const source = `version = 1\nplugins = { bundled = { group = { enabled = false }, "hide-files" = { enabled = false }, summarize = { system_prompt = "Keep me", max_concurrency = 2 } }, order = ["bundled.group", "bundled.hide-files", "bundled.summarize"] }\n`;
  expect(parse(migrateDiffrConfig(source))).toEqual({
    version: 2,
    plugins: {
      classify: { bundled: { hide: [], hide_deleted: false } },
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config namespace.
      shape: {
        bundled: { summarize: { system_prompt: "Keep me" } },
        order: ["bundled.summarize"],
      },
    },
  });
  const dotted = `plugins.bundled.group.enabled = true\nplugins.bundled."hide-files".deleted = false\nclassifier = { hide = ["vendored"] }\n`;
  expect(parse(migrateDiffrConfig(dotted)).plugins).toEqual({
    classify: {
      bundled: {
        hide: ["vendored"],
        hide_deleted: false,
      },
    },
  });
});

test("retains explicit modern classifier values in a mixed config", () => {
  const source = `[classifier]\nhide = ["custom"]\nhide_deleted = true\n[plugins.bundled.hide-files]\nenabled = false\n`;
  expect(parse(migrateDiffrConfig(source))).toEqual({
    version: 2,
    plugins: {
      classify: { bundled: { hide: ["custom"], hide_deleted: true } },
    },
  });
});

test("removes retired names from a custom order without sorting surviving plugins", () => {
  const source = `[plugins]\norder = ["bundled.context", "bundled.group", "external.custom", "bundled.hide-files", "bundled.summarize"]\n`;
  expect(parse(migrateDiffrConfig(source))).toEqual({
    version: 2,
    plugins: {
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config namespace.
      shape: {
        order: ["bundled.context", "custom", "bundled.summarize"],
      },
    },
  });
});

test("retains comments inside a rewritten plugin order", () => {
  const source = `[plugins]\norder = [\n"bundled.context", # keep context first\n"bundled.group", # retired group\n"bundled.summarize",\n]\n`;
  const migrated = migrateDiffrConfig(source);
  expect(parse(migrated)).toEqual({
    version: 2,
    plugins: {
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config namespace.
      shape: { order: ["bundled.context", "bundled.summarize"] },
    },
  });
  expect(migrated.match(/# keep context first/g)).toHaveLength(1);
  expect(migrated.match(/# retired group/g)).toHaveLength(1);
});

async function fixture() {
  const root = await mkdtemp(
    path.join(tmpdir(), "whiteboard-config-migration-"),
  );

  roots.push(root);
  const file = path.join(root, "diffr", "config.toml");
  await mkdir(path.dirname(file));
  const executable = path.join(root, "diffr-cli");
  await writeFile(
    executable,
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst path = require('node:path');\nif (process.argv[3] !== 'show') process.exit(3);\n{\n const candidate = fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME,'diffr','config.toml'),'utf8');\n if (process.env.CAPTURE_CANDIDATE) fs.writeFileSync(process.env.CAPTURE_CANDIDATE, candidate);\n if (process.env.REJECT_CANDIDATE) { console.error('synthetic secret'); process.exit(2); }\n if (process.env.CONCURRENT_EDIT) fs.writeFileSync(${JSON.stringify(file)}, 'version = 1 # concurrent edit\\n');\n if (candidate.includes('plugins.bundled.group')) process.exit(2);\n console.log('{}');\n}\n`,
    { mode: 0o755 },
  );

  return {
    root,
    file,
    executable,
    env: { ...process.env, XDG_CONFIG_HOME: root },
  };
}

test("validates before writing, backs up privately and is a no-op on a second run", async () => {
  const { root, file, executable, env } = await fixture();
  const source = `[plugins.bundled.group]\nenabled = false # retired\n`;
  await writeFile(file, source);
  expect(await ensureDiffrConfigMigrated(executable, env)).toBe(true);
  const migrated = await readFile(file, "utf8");
  expect(parse(migrated)).toEqual({ version: 2 });

  const backup = (await readdir(path.dirname(file))).find((name) =>
    name.includes(".before-whiteboard-config-v2."),
  )!;

  expect(await readFile(path.join(path.dirname(file), backup), "utf8")).toBe(
    source,
  );

  expect(await ensureDiffrConfigMigrated(executable, env)).toBe(false);
  expect(await readFile(file, "utf8")).toBe(migrated);
  expect(
    (await readdir(path.join(root, "diffr"))).some((name) =>
      name.startsWith(".whiteboard-config-"),
    ),
  ).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "keeps backup credentials private",
  async () => {
    const { file, executable, env } = await fixture();
    await writeFile(file, `[plugins.bundled.group]\nenabled = false\n`);
    await ensureDiffrConfigMigrated(executable, env);

    const backup = (await readdir(path.dirname(file))).find((name) =>
      name.includes(".before-whiteboard-config-v2."),
    )!;

    expect(
      (await stat(path.join(path.dirname(file), backup))).mode & 0o777,
    ).toBe(0o600);
  },
);

test("does not run the binary or change a version 2 file", async () => {
  const { file, env } = await fixture();

  const source =
    "version = 2 # already migrated\n[plugins.shape.bundled.context]\nlines = 8\n";

  await writeFile(file, source);
  expect(await ensureDiffrConfigMigrated("/no/binary/needed", env)).toBe(false);
  expect(await readFile(file, "utf8")).toBe(source);
  expect(await readdir(path.dirname(file))).toEqual(["config.toml"]);
});

test("keeps an unknown config version unchanged", async () => {
  const { file, env } = await fixture();
  const source = "version = 3\n";
  await writeFile(file, source);
  await expect(
    ensureDiffrConfigMigrated("/no/binary/needed", env),
  ).rejects.toThrow("Unsupported diffr config version: 3");
  expect(await readFile(file, "utf8")).toBe(source);
  expect(await readdir(path.dirname(file))).toEqual(["config.toml"]);
});

test("keeps the original and hides provider output when validation fails", async () => {
  const { file, executable, env } = await fixture();
  const source = `[plugins.bundled.group]\nenabled = false\n`;
  await writeFile(file, source);
  await expect(
    ensureDiffrConfigMigrated(executable, { ...env, REJECT_CANDIDATE: "1" }),
  ).rejects.toThrow("The original file was kept");
  expect(await readFile(file, "utf8")).toBe(source);
  expect(await readdir(path.dirname(file))).toEqual(["config.toml"]);
});

test("does not replace an external edit made during validation", async () => {
  const { file, executable, env } = await fixture();
  await writeFile(file, `[plugins.bundled.group]\nenabled = false\n`);
  await expect(
    ensureDiffrConfigMigrated(executable, { ...env, CONCURRENT_EDIT: "1" }),
  ).rejects.toThrow("changed during migration");
  expect(await readFile(file, "utf8")).toBe("version = 1 # concurrent edit\n");
});

test("uses the caller directory and preserves relative paths in the saved file", async () => {
  const { root, file, env } = await fixture();
  const source = `[theme]\npath = "themes/custom.toml"\n[plugins.bundled.group]\nenabled = true\n`;
  await writeFile(file, source);
  const captured = path.join(root, "candidate.toml");
  expect(
    await ensureDiffrConfigMigrated(
      "./diffr-cli",
      {
        ...env,
        XDG_CONFIG_HOME: ".",
        CAPTURE_CANDIDATE: captured,
      },
      undefined,
      root,
    ),
  ).toBe(true);
  expect(parse(await readFile(captured, "utf8")).theme).toEqual({
    path: path.join(path.dirname(file), "themes/custom.toml"),
  });
  expect(parse(await readFile(file, "utf8")).theme).toEqual({
    path: "themes/custom.toml",
  });
});

test("migrates a version-only config and leaves v2 text unchanged", () => {
  expect(parse(migrateDiffrConfig("version = 1 # format\n"))).toEqual({
    version: 2,
  });
  const source = "version = 2 # format\n";
  expect(migrateDiffrConfig(source)).toBe(source);
  expect(() => migrateDiffrConfig("version = 7\n")).toThrow(
    "Unsupported diffr config version: 7",
  );
});

test("moves plugin options and external paths without rewriting value bytes", () => {
  const source = `version = 1
[plugins.bundled.context]
lines = 0x10 # keep spelling
extra = { option = 'custom', nested = [1, 2] }
[plugins.external.custom]
path = 'plugins/custom' # keep relative
threshold = 1_000
[classifier]
hide = ['custom'] # keep tags
[diff]
byte_limit = 1_000_000
`;

  const migrated = migrateDiffrConfig(source);
  expect(parse(migrated)).toEqual({
    version: 2,
    plugins: {
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config namespace.
      shape: {
        bundled: {
          context: { lines: 16, extra: { option: "custom", nested: [1, 2] } },
        },
        custom: { path: "plugins/custom", threshold: 1000 },
      },
      classify: { bundled: { hide: ["custom"] } },
    },
    diff: { byte_limit: 1000000 },
  });

  for (const line of source
    .split("\n")
    .filter((line) => line.includes(" = ") && !line.startsWith("version")))
    expect(migrated).toContain(line);
});

test("preserves bundled and custom plugins with the same basename", () => {
  const source = `[plugins.bundled.context]
enabled = false
lines = 9
[plugins.external.context]
path = "custom/context"
`;

  const migrated = migrateDiffrConfig(source);
  expect(parse(migrated)).toEqual({
    version: 2,
    plugins: {
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config namespace.
      shape: {
        bundled: { context: { enabled: false, lines: 9 } },
        context: { path: "custom/context" },
      },
    },
  });
  expect(migrated).toContain("lines = 9");
});

test("moves a custom classifier under its manifest name and validates its original path", async () => {
  const { root, file, executable, env } = await fixture();
  const directory = path.join(root, "diffr", "custom-classifier");
  await mkdir(directory);
  await writeFile(
    path.join(directory, "plugin.toml"),
    'name = "team.classifier"\n',
  );

  const source =
    '[classifier]\npath = "custom-classifier" # local plugin\nhide = ["team"]\n';

  await writeFile(file, source);
  const captured = path.join(root, "candidate.toml");
  await ensureDiffrConfigMigrated(executable, {
    ...env,
    CAPTURE_CANDIDATE: captured,
  });
  expect(parse(await readFile(file, "utf8"))).toEqual({
    version: 2,
    plugins: {
      classify: {
        "team.classifier": { path: "custom-classifier", hide: ["team"] },
      },
    },
  });
  expect(parse(await readFile(captured, "utf8"))).toEqual({
    version: 2,
    plugins: {
      classify: { "team.classifier": { path: directory, hide: ["team"] } },
    },
  });
});

test("keeps a custom classifier config when its manifest cannot be read", async () => {
  const { file, executable, env } = await fixture();
  const source = '[classifier]\npath = "missing-plugin"\n';
  await writeFile(file, source);
  await expect(ensureDiffrConfigMigrated(executable, env)).rejects.toThrow(
    "could not read the custom classifier manifest",
  );
  expect(await readFile(file, "utf8")).toBe(source);
});

test("redacts saved credentials from invalid TOML and schema errors", async () => {
  const { file, executable, env } = await fixture();

  for (const source of [
    'plugins.bundled.summarize.api_key = "saved-secret" unexpected\n',
    'plugins.bundled.summarize = "saved-secret"\n',
  ]) {
    await writeFile(file, source);
    const result = ensureDiffrConfigMigrated(executable, env);
    await expect(result).rejects.toThrow("could not migrate the saved config");
    await expect(result).rejects.not.toThrow("saved-secret");
    expect(await readFile(file, "utf8")).toBe(source);
    expect(await readdir(path.dirname(file))).toEqual(["config.toml"]);
  }
});

test("serializes concurrent startup migrations and writes one backup", async () => {
  const { file, executable, env } = await fixture();
  const source = "version = 1\n[plugins.bundled.context]\nlines = 11\n";
  await writeFile(file, source);

  const results = await Promise.all([
    ensureDiffrConfigMigrated(executable, env),
    ensureDiffrConfigMigrated(executable, env),
  ]);

  expect(results.sort()).toEqual([false, true]);
  expect(parse(await readFile(file, "utf8"))).toEqual({
    version: 2,
    plugins: {
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config namespace.
      shape: { bundled: { context: { lines: 11 } } },
    },
  });

  const backups = (await readdir(path.dirname(file))).filter((name) =>
    name.includes("before-whiteboard-config-v2"),
  );

  expect(backups).toHaveLength(1);
  expect(
    await readFile(path.join(path.dirname(file), backups[0]), "utf8"),
  ).toBe(source);
});

test("migrates same-basename stock and custom entries on disk", async () => {
  const { file, executable, env } = await fixture();

  const source =
    '[plugins.bundled.context]\nenabled = false\n[plugins.external.context]\npath = "custom"\n';

  await writeFile(file, source);
  expect(await ensureDiffrConfigMigrated(executable, env)).toBe(true);
  expect(parse(await readFile(file, "utf8"))).toEqual({
    version: 2,
    plugins: {
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config namespace.
      shape: {
        bundled: { context: { enabled: false } },
        context: { path: "custom" },
      },
    },
  });

  const backup = (await readdir(path.dirname(file))).find((name) =>
    name.includes("before-whiteboard-config-v2"),
  )!;

  expect(await readFile(path.join(path.dirname(file), backup), "utf8")).toBe(
    source,
  );
});

test.each([
  '[plugins.external."team.custom"]\npath = "plugins/custom"\n"option.name" = 0x10\n',
  'plugins.external."team.custom".path = "plugins/custom"\nplugins.external."team.custom"."option.name" = 0x10\n',
  'plugins = { external = { "team.custom" = { path = "plugins/custom", "option.name" = 0x10 } } }\n',
])("retains literal dots in external plugin and option names", (source) => {
  const migrated = migrateDiffrConfig(source);
  expect(parse(migrated)).toEqual({
    version: 2,
    plugins: {
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config namespace.
      shape: { "team.custom": { path: "plugins/custom", "option.name": 16 } },
    },
  });
  expect(migrated).toContain("0x10");
});

test.each(["order", "bundled", "bundled.context"])(
  "refuses reserved custom plugin name %s",
  (name) => {
    expect(() =>
      migrateDiffrConfig(
        `[plugins.external.${JSON.stringify(name)}]\npath = "plugins/custom"\n`,
      ),
    ).toThrow(`custom plugin named ${name}`);
  },
);

// Historical literals copied from diffr defaults and config/prune.rs.
test.each([
  'For each listed fold, rewrite that function body as short python-flavored pseudocode. Keep the names. No prose, no comments, no code fences. Use as few lines as possible: about one pseudocode line per five source lines, and never more than a third of the body\'s lines. When a fold lists a doc, also set "summary" to one sentence copied verbatim from that doc; otherwise leave it empty. Answer with a JSON array of {"id", "summary", "pseudocode"} objects, one per fold.',
  'For each listed fold, rewrite that function body as short pseudocode. Keep the names. No prose, no comments, no code fences. Use as few lines as possible: about one pseudocode line per five source lines, and never more than a third of the body\'s lines. When a fold lists a doc, also set "summary" to one sentence copied verbatim from that doc; otherwise leave it empty. Answer with a JSON array of {"id", "summary", "pseudocode"} objects, one per fold.',
  'For each listed fold, rewrite that function body as short pseudocode. Keep the names. No prose, no comments, no code fences. Use as few lines as possible: about one pseudocode line per five source lines, and never more than a third of the body\'s lines. When a fold lists a doc, also set "summary" to one sentence copied verbatim from that doc; otherwise leave it empty. Answer with a JSON object whose "summaries" array holds one {"id", "summary", "pseudocode"} object per fold.',
])("resets historical stock prompt %# but retains edits", (stockPrompt) => {
  const source = `[plugins.bundled.summarize]\nsystem_prompt = ${JSON.stringify(stockPrompt)} # old default\n`;
  const migrated = migrateDiffrConfig(source);
  expect(parse(migrated)).toEqual({
    version: 2,
    plugins: {
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config namespace.
      shape: { bundled: { summarize: {} } },
    },
  });
  expect(migrated).toContain("# old default");

  for (const custom of [
    " " + stockPrompt,
    stockPrompt + " Keep my team naming.",
  ]) {
    const literal = JSON.stringify(custom);

    const migratedCustom = migrateDiffrConfig(
      `[plugins.bundled.summarize]\nsystem_prompt = ${literal} # custom prompt\n`,
    );

    expect(
      new TomlEdits(migratedCustom).value(
        "plugins.shape.bundled.summarize.system_prompt",
      ),
    ).toBe(custom);
    expect(migratedCustom).toContain(
      `system_prompt = ${literal} # custom prompt`,
    );
  }
});

test("moves the old default context-first order to the v2 context-last default", () => {
  const source =
    '[plugins]\norder = ["bundled.context", "bundled.hide-files", "bundled.deleted-bodies", "bundled.summarize", "bundled.test-bodies", "bundled.removed-runs", "bundled.group"]\n';

  expect(
    new TomlEdits(migrateDiffrConfig(source)).value("plugins.shape.order"),
  ).toEqual([
    "bundled.deleted-bodies",
    "bundled.summarize",
    "bundled.test-bodies",
    "bundled.removed-runs",
    "bundled.context",
  ]);
});

test("keeps new namespaces while removing only legacy parent tables", () => {
  const source = `version = 1
[plugins] # pipeline config
order = ["bundled.context", "external.team.custom"]
[plugins.bundled] # built-in plugins
context = { lines = 0x10 }
[plugins.external] # custom plugins
"team.custom" = { path = 'plugins/custom', threshold = 1_000 }
[classifier] # file tags
hide = ['team']
`;

  const migrated = migrateDiffrConfig(source);
  expect(parse(migrated)).toEqual({
    version: 2,
    plugins: {
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config namespace.
      shape: {
        order: ["bundled.context", "team.custom"],
        bundled: { context: { lines: 16 } },
        "team.custom": { path: "plugins/custom", threshold: 1000 },
      },
      classify: { bundled: { hide: ["team"] } },
    },
  });
  expect(migrated).toContain("lines = 0x10");
  expect(migrated).toContain("threshold = 1_000");

  for (const comment of [
    "pipeline config",
    "built-in plugins",
    "custom plugins",
    "file tags",
  ])
    expect(migrated).toContain(`# ${comment}`);
});

test("keeps a custom classifier whose name conflicts with bundled unchanged", async () => {
  const { root, file, executable, env } = await fixture();
  const directory = path.join(root, "diffr", "custom-classifier");
  await mkdir(directory);
  await writeFile(path.join(directory, "plugin.toml"), 'name = "bundled"\n');
  const source = '[classifier]\npath = "custom-classifier"\nhide = ["team"]\n';
  await writeFile(file, source);
  await expect(ensureDiffrConfigMigrated(executable, env)).rejects.toThrow(
    "custom classifier named bundled",
  );
  expect(await readFile(file, "utf8")).toBe(source);
  expect(await readdir(path.dirname(file))).toEqual([
    "config.toml",
    "custom-classifier",
  ]);
});

test("retains order references for bundled and custom plugins with the same basename", () => {
  const source = `[plugins]
order = ["external.context", "bundled.context"]
[plugins.bundled.context]
enabled = false
lines = 0x10 # stock override
[plugins.external.context]
path = 'custom/context' # custom path
lines = 1_000 # custom override
`;

  const migrated = migrateDiffrConfig(source);
  expect(parse(migrated)).toEqual({
    version: 2,
    plugins: {
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Native diffr v2 config namespace.
      shape: {
        order: ["context", "bundled.context"],
        bundled: { context: { enabled: false, lines: 16 } },
        context: { path: "custom/context", lines: 1000 },
      },
    },
  });

  for (const line of source.split("\n").filter((line) => line.includes("#")))
    expect(migrated).toContain(line);
});

test("keeps reserved custom plugin entries unchanged on disk", async () => {
  const { file, executable, env } = await fixture();

  const source =
    '[plugins.external."bundled.context"]\npath = "custom/context"\n';

  await writeFile(file, source);
  await expect(ensureDiffrConfigMigrated(executable, env)).rejects.toThrow(
    "custom plugin named bundled.context",
  );
  expect(await readFile(file, "utf8")).toBe(source);
  expect(await readdir(path.dirname(file))).toEqual(["config.toml"]);
});
