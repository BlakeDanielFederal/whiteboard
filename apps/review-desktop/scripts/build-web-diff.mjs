#!/usr/bin/env node
// Bundles the browser diff library (code-oss/src/vs/review/web/reviewWebDiff.ts)
// and its editor worker for the Whiteboard web host. The Desktop build does not
// use this output.

import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
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

// Resolved from the fork outward, as the fork's own build scripts resolve it.
const esbuild = createRequire(path.join(codeOss, "package.json"))("esbuild");

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

/** A color theme's workbench colors, its `include` chain applied first. */
async function themeColors(file) {
  const theme = parseJsonc(await readFile(file, "utf8"));

  const included = theme.include
    ? await themeColors(path.resolve(path.dirname(file), theme.include))
    : {};

  return { ...included, ...theme.colors };
}

/** Desktop's Whiteboard themes, so diffs and editors use the same colors. */
async function reviewThemes() {
  const themes = path.join(codeOss, "extensions/review-themes/themes");

  return {
    light: {
      base: "vs",
      inherit: true,
      rules: [],
      colors: await themeColors(path.join(themes, "review-light.json")),
    },
    dark: {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: await themeColors(path.join(themes, "review-dark.json")),
    },
  };
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

const result = await esbuild.build({
  define: { __REVIEW_WEB_THEMES__: JSON.stringify(await reviewThemes()) },
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
