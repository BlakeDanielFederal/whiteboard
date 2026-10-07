import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { withFileLock, writeFileAtomicAsync } from "@dev.fast/trace-core";
import { parse } from "smol-toml";
import { z } from "zod";

import { TomlEdits, tomlKey, tomlKeyParts } from "./toml-edits.js";

const execute = promisify(execFile);

class ConfigMigrationError extends Error {}

const oldOrder = [
  "bundled.context",
  "bundled.hide-files",
  "bundled.deleted-bodies",
  "bundled.summarize",
  "bundled.test-bodies",
  "bundled.removed-runs",
  "bundled.group",
];

const newOrder = [
  "bundled.deleted-bodies",
  "bundled.summarize",
  "bundled.test-bodies",
  "bundled.removed-runs",
  "bundled.context",
];

// Exact defaults written by older diffr releases; edited prompts stay intact.
const stockPrompts = new Set([
  'For each listed fold, rewrite that function body as short python-flavored pseudocode. Keep the names. No prose, no comments, no code fences. Use as few lines as possible: about one pseudocode line per five source lines, and never more than a third of the body\'s lines. When a fold lists a doc, also set "summary" to one sentence copied verbatim from that doc; otherwise leave it empty. Answer with a JSON array of {"id", "summary", "pseudocode"} objects, one per fold.',
  'For each listed fold, rewrite that function body as short pseudocode. Keep the names. No prose, no comments, no code fences. Use as few lines as possible: about one pseudocode line per five source lines, and never more than a third of the body\'s lines. When a fold lists a doc, also set "summary" to one sentence copied verbatim from that doc; otherwise leave it empty. Answer with a JSON array of {"id", "summary", "pseudocode"} objects, one per fold.',
  'For each listed fold, rewrite that function body as short pseudocode. Keep the names. No prose, no comments, no code fences. Use as few lines as possible: about one pseudocode line per five source lines, and never more than a third of the body\'s lines. When a fold lists a doc, also set "summary" to one sentence copied verbatim from that doc; otherwise leave it empty. Answer with a JSON object whose "summaries" array holds one {"id", "summary", "pseudocode"} object per fold.',
]);

const configVersionSchema = z.object({ version: z.number().int().optional() });

const pluginEntrySchema = z.record(z.string(), z.unknown());

const legacyConfigSchema = z.object({
  plugins: z
    .object({
      order: z.array(z.string()).optional(),
      bundled: z.record(z.string(), pluginEntrySchema).optional(),
      external: z.record(z.string(), pluginEntrySchema).optional(),
    })
    .optional(),
  classifier: pluginEntrySchema.optional(),
});

const legacyHideSchema = z.object({
  enabled: z.boolean().default(true),
  tags: z.array(z.string()).default(["generated", "vendored", "test"]),
  deleted: z.boolean().default(true),
});

const legacySummarySchema = z.object({ system_prompt: z.string().optional() });

/** Convert v1 paths to v2 without serializing saved plugin option values. */
export function migrateDiffrConfig(
  source: string,
  classifierName = "bundled",
): string {
  const parsed = parse(source);
  const version = configVersionSchema.parse(parsed).version ?? 1;

  if (version === 2) return source;

  if (version !== 1)
    throw new ConfigMigrationError(
      `Unsupported diffr config version: ${version}`,
    );

  const config = legacyConfigSchema.parse(parsed);
  const bundled = config.plugins?.bundled;
  const external = config.plugins?.external;
  const edits = new TomlEdits(source);

  for (const name of Object.keys(external ?? {}))
    if (name === "order" || name === "bundled" || name.startsWith("bundled."))
      throw new ConfigMigrationError(
        `diffr config has a custom plugin named ${name}. Rename that plugin before migration; plugins.shape.${name} is reserved.`,
      );

  if (config.classifier?.path !== undefined && classifierName === "bundled")
    throw new ConfigMigrationError(
      "diffr config has a custom classifier named bundled. Rename that plugin before migration; plugins.classify.bundled is reserved.",
    );

  // The independent group switch is retired, for either saved boolean value.
  edits.remove("plugins.bundled.group");

  if (bundled?.["hide-files"] !== undefined) {
    const hide = legacyHideSchema.parse(bundled["hide-files"]);

    // Explicit classifier settings in a mixed v1 file take precedence.
    if (config.classifier?.hide === undefined)
      edits.set("classifier.hide", hide.enabled ? hide.tags : []);

    if (config.classifier?.hide_deleted === undefined)
      edits.set("classifier.hide_deleted", hide.enabled && hide.deleted);
    edits.remove("plugins.bundled.hide-files");
  }

  if (config.plugins?.order) {
    const order = config.plugins.order;

    const migrated =
      JSON.stringify(order) === JSON.stringify(oldOrder)
        ? newOrder
        : order
            .filter(
              (name) =>
                name !== "bundled.group" && name !== "bundled.hide-files",
            )
            .map((name) => name.replace(/^external\./, ""));

    edits.set("plugins.order", migrated);
    edits.move("plugins.order", "plugins.shape.order");
  }

  // This old option was accepted but ignored. Do not turn it into --jobs.
  edits.remove("plugins.bundled.summarize.max_concurrency");

  const summary =
    bundled?.summarize === undefined
      ? undefined
      : legacySummarySchema.parse(bundled.summarize);

  // Keep custom prompts exactly; reset only these historical stock defaults.
  const resetPrompt =
    summary?.system_prompt !== undefined &&
    stockPrompts.has(summary.system_prompt);

  if (resetPrompt) edits.remove("plugins.bundled.summarize.system_prompt");

  for (const name of Object.keys(bundled ?? {}))
    if (name !== "group" && name !== "hide-files")
      edits.move(
        tomlKey("plugins", "bundled", name),
        tomlKey("plugins", "shape", "bundled", name),
      );

  for (const name of Object.keys(external ?? {}))
    edits.move(
      tomlKey("plugins", "external", name),
      tomlKey("plugins", "shape", name),
    );

  edits.remove("plugins.bundled");
  edits.remove("plugins.external");
  edits.move("classifier", tomlKey("plugins", "classify", classifierName));
  edits.set("version", 2);

  const movedValues: [string, string][] = [];

  for (const key of new TomlEdits(source).valueKeys()) {
    if (
      key.startsWith("plugins.bundled.group.") ||
      key.startsWith("plugins.bundled.hide-files.") ||
      key === "plugins.bundled.summarize.max_concurrency" ||
      (key === "plugins.bundled.summarize.system_prompt" && resetPrompt)
    )
      continue;

    if (key.startsWith("plugins.bundled."))
      movedValues.push([
        key,
        key.replace("plugins.bundled.", "plugins.shape.bundled."),
      ]);

    if (key.startsWith("plugins.external."))
      movedValues.push([
        key,
        key.replace("plugins.external.", "plugins.shape."),
      ]);

    if (key.startsWith("classifier."))
      movedValues.push([
        key,
        key.replace(
          "classifier.",
          `${tomlKey("plugins", "classify", classifierName)}.`,
        ),
      ]);
  }

  edits.assertUnchanged(source, movedValues);

  return edits.source;
}

/** Run once at startup; v2 files do not need binary probing or validation. */
export async function ensureDiffrConfigMigrated(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  cwd?: string,
): Promise<boolean> {
  const file = path.resolve(
    cwd ?? process.cwd(),
    env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
    "diffr",
    "config.toml",
  );

  const target = await realpath(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

  if (!target) return false;

  const result = await withFileLock(
    `${target}.whiteboard-migration.lock`,
    {
      retryMs: 25,
      staleMs: 120_000,
      timeoutMs: 30_000,
      unownedGraceMs: 5_000,
    },
    async () => {
      signal?.throwIfAborted();
      const original = await readFile(target, "utf8");
      let candidate: string;

      try {
        const version = configVersionSchema.parse(parse(original)).version ?? 1;

        if (version === 2) return false;

        if (version !== 1)
          throw new ConfigMigrationError(
            `Unsupported diffr config version: ${version}`,
          );
        const classifierName = await legacyClassifierName(original, file);
        candidate = migrateDiffrConfig(original, classifierName);
      } catch (error) {
        if (error instanceof ConfigMigrationError) throw error;
        // TOML and schema errors can contain the source and saved credentials.
        throw new Error(
          "diffr could not migrate the saved config. The original file was kept.",
        );
      }

      if (candidate === original) return false;

      // Validate from a sibling config directory, with relative paths made absolute.
      await validateDiffrConfig(executable, candidate, file, env, signal, cwd);

      if ((await readFile(target, "utf8")) !== original)
        throw new Error("diffr config changed during migration. Try again.");

      const hash = createHash("sha256")
        .update(original)
        .digest("hex")
        .slice(0, 16);

      const backup = `${target}.before-whiteboard-config-v2.${hash}`;

      try {
        await writeFile(backup, original, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;

        if ((await readFile(backup, "utf8")) !== original)
          throw new Error(
            "diffr migration backup already exists for different config. Keep it and move it before retrying.",
          );
      }

      signal?.throwIfAborted();

      if ((await readFile(target, "utf8")) !== original)
        throw new Error("diffr config changed during migration. Try again.");
      await writeFileAtomicAsync(target, candidate, {
        encoding: "utf8",
        mode: 0o600,
      });

      return true;
    },
  );

  if (!result.acquired) throw new Error("diffr config is busy. Try again.");

  return result.result;
}

async function legacyClassifierName(
  source: string,
  file: string,
): Promise<string> {
  const classifier = legacyConfigSchema.parse(parse(source)).classifier;

  if (classifier?.path === undefined) return "bundled";

  const directory = path.resolve(
    path.dirname(file),
    z.string().parse(classifier.path),
  );

  try {
    const manifest = z
      .object({ name: z.string().min(1) })
      .parse(
        parse(await readFile(path.join(directory, "plugin.toml"), "utf8")),
      );

    return manifest.name;
  } catch {
    throw new ConfigMigrationError(
      "diffr could not read the custom classifier manifest. The original file was kept.",
    );
  }
}

async function validateDiffrConfig(
  executable: string,
  source: string,
  file: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  cwd?: string,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(path.dirname(file), ".whiteboard-config-"),
  );

  try {
    const edits = new TomlEdits(source);

    // Moving the candidate for validation must not move theme or plugin paths.
    for (const key of edits.keys()) {
      const parts = tomlKeyParts(key);

      if (
        key === "theme.path" ||
        (parts.length === 4 &&
          parts[0] === "plugins" &&
          (parts[1] === "shape" || parts[1] === "classify") &&
          parts[3] === "path") ||
        (parts.length === 5 &&
          parts[0] === "plugins" &&
          parts[1] === "shape" &&
          parts[2] === "bundled" &&
          parts[4] === "path")
      ) {
        const value = z.string().parse(edits.value(key));

        if (!path.isAbsolute(value))
          edits.set(key, path.resolve(path.dirname(file), value));
      }
    }

    await mkdir(path.join(directory, "diffr"), { mode: 0o700 });
    await writeFile(
      path.join(directory, "diffr", "config.toml"),
      edits.source,
      { mode: 0o600 },
    );

    try {
      await execute(executable, ["config", "show", "--json"], {
        env: { ...env, XDG_CONFIG_HOME: directory },
        cwd,
        signal: signal ?? AbortSignal.timeout(30_000),
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      signal?.throwIfAborted();
      throw new Error(
        "diffr could not validate the migrated config. The original file was kept.",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
