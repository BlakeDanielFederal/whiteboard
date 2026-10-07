#!/usr/bin/env node
// Bundles the browser diff library (code-oss/src/vs/review/web/reviewWebDiff.ts)
// and its editor worker for the Whiteboard web host. The Desktop build does not
// use this output.

import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const codeOss = path.join(desktopRoot, "code-oss");

const source = path.join(codeOss, "src");

const outDir = path.resolve(
  process.argv[2] ??
    path.join(desktopRoot, "../../packages/review/app/dist/web/diff"),
);

// Packages resolve from the fork outward, as the fork's own build scripts do.
const requireFork = createRequire(path.join(codeOss, "package.json"));

const esbuild = requireFork("esbuild");

/** Parses a theme file: JSON with comments and trailing commas. */
function parseJsonc(text) {
  let out = "";

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '"') {
      const start = i;

      for (i++; text[i] !== '"'; i++) if (text[i] === "\\") i++;

      out += text.slice(start, i + 1);
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;

      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += char;
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** A color theme's colors and token colors, its `include` chain applied first. */
async function resolveTheme(file) {
  const theme = parseJsonc(await readFile(file, "utf8"));

  const included = theme.include
    ? await resolveTheme(path.resolve(path.dirname(file), theme.include))
    : { colors: {}, tokenColors: [] };

  return {
    colors: { ...included.colors, ...theme.colors },
    tokenColors: [...included.tokenColors, ...(theme.tokenColors ?? [])],
  };
}

/**
 * Desktop's Whiteboard themes, so diffs, editors and syntax use the same colors.
 * Token colors get the editor's default colors first and their color map
 * precomputed, as the workbench's color theme does.
 */
async function reviewThemes() {
  const themes = path.join(codeOss, "extensions/review-themes/themes");

  const { Registry } = requireFork("vscode-textmate");

  const resolve = async (file, base) => {
    const { colors, tokenColors } = await resolveTheme(path.join(themes, file));

    const settings = [
      {
        settings: {
          foreground: colors["editor.foreground"],
          background: colors["editor.background"],
        },
      },
      ...tokenColors,
    ];

    const registry = new Registry({
      onigLib: Promise.resolve(),
      loadGrammar: async () => null,
      theme: { settings },
    });

    return {
      editor: { base, inherit: true, rules: [], colors },
      tokens: { settings, colorMap: registry.getColorMap() },
    };
  };

  return {
    light: await resolve("review-light.json", "vs"),
    dark: await resolve("review-dark.json", "vs-dark"),
  };
}

/**
 * The language definitions and TextMate grammars that Desktop's built-in
 * language extensions contribute. Grammars are copied beside the bundle and
 * loaded per language on first use.
 */
async function reviewLanguages() {
  const extensionsDir = path.join(codeOss, "extensions");

  const languages = [];

  const grammars = [];

  for (const extension of (await readdir(extensionsDir)).sort()) {
    const manifestPath = path.join(extensionsDir, extension, "package.json");

    let manifest;

    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }

    const contributes = manifest.contributes ?? {};

    for (const language of contributes.languages ?? []) {
      const { configuration, ...definition } = language;

      let brackets;

      if (configuration) {
        try {
          const config = parseJsonc(
            await readFile(
              path.join(extensionsDir, extension, configuration),
              "utf8",
            ),
          );

          brackets = {
            brackets: config.brackets,
            comments: config.comments,
            colorizedBracketPairs: config.colorizedBracketPairs,
          };
        } catch {
          // A language without a readable configuration still highlights.
        }
      }

      languages.push({ ...definition, configuration: brackets });
    }

    for (const grammar of contributes.grammars ?? []) {
      const from = path.join(extensionsDir, extension, grammar.path);

      const to = path.join("grammars", extension, grammar.path);

      await mkdir(path.dirname(path.join(outDir, to)), { recursive: true });

      await copyFile(from, path.join(outDir, to));

      grammars.push({ ...grammar, path: to.split(path.sep).join("/") });
    }
  }

  return { languages, grammars };
}

// The fork reads the review protocol from a generated overlay.
execFileSync(
  process.execPath,
  [path.join(desktopRoot, "scripts/protocol-sync.mjs")],
  { stdio: "inherit" },
);

// The codicon font is copied from node_modules, as the fork's gulp build does.
await copyFile(
  path.join(codeOss, "node_modules/@vscode/codicons/dist/codicon.ttf"),
  path.join(source, "vs/base/browser/ui/codicons/codicon/codicon.ttf"),
);

await rm(outDir, { recursive: true, force: true });

await mkdir(outDir, { recursive: true });

// Grammars run on oniguruma, compiled to WebAssembly.
await copyFile(
  path.join(codeOss, "node_modules/vscode-oniguruma/release/onig.wasm"),
  path.join(outDir, "onig.wasm"),
);

const result = await esbuild.build({
  define: {
    __REVIEW_WEB_THEMES__: JSON.stringify(await reviewThemes()),
    __REVIEW_WEB_LANGUAGES__: JSON.stringify(await reviewLanguages()),
  },
  entryPoints: [
    {
      in: path.join(source, "vs/review/web/reviewWebDiff.ts"),
      out: "reviewWebDiff",
    },
    {
      in: path.join(source, "vs/editor/common/services/editorWebWorkerMain.ts"),
      out: "workerMain",
    },
  ],
  outdir: outDir,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2024"],
  splitting: false,
  minify: true,
  sourcemap: "linked",
  treeShaking: true,
  // The fork's services are injected through parameter decorators.
  tsconfigRaw: {
    compilerOptions: {
      experimentalDecorators: true,
      useDefineForClassFields: false,
    },
  },
  loader: { ".ttf": "file", ".svg": "file", ".png": "file" },
  assetNames: "media/[name]",
  logLevel: "warning",
  logOverride: { "unsupported-require-call": "silent" },
  metafile: true,
});

const outputs = Object.entries(result.metafile.outputs).filter(
  ([file]) => !file.endsWith(".map"),
);

for (const [file, output] of outputs)
  console.log(
    `${path.relative(process.cwd(), file)}  ${(output.bytes / 1024).toFixed(0)} KiB`,
  );

const total = outputs.reduce((sum, [, output]) => sum + output.bytes, 0);

console.log(
  `web diff bundle: ${(total / 1024 / 1024).toFixed(2)} MiB in ${outDir}`,
);

await stat(path.join(outDir, "reviewWebDiff.js"));
