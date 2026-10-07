import path from "node:path";

import { defineConfig } from "vite";

import { canvasOutputNames, canvasPlugins, canvasResolve } from "./canvas-vite";
import { scopeReviewCanvasCss } from "./desktop-css-scope";
import { stylexOptions } from "./stylex-options";

export default defineConfig({
  root: __dirname,
  plugins: [
    ...canvasPlugins(stylexOptions),
    {
      // Runs after StyleX has appended its rules to the canvas CSS asset.
      name: "scope-review-canvas-css",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "asset" || !output.fileName.endsWith(".css")) {
            continue;
          }

          const source =
            output.source instanceof Uint8Array
              ? new TextDecoder().decode(output.source)
              : output.source;

          output.source = scopeReviewCanvasCss(source);
        }
      },
    },
  ],
  resolve: canvasResolve,
  // Relative asset URLs: the stylesheet is loaded by `<link>` from the workbench
  // `out/vs/review/canvas/assets` directory, so `url(...)` references inside it
  // (the bundled Geist Mono / Newsreader faces) must resolve against the CSS
  // file, not the `vscode-file://vscode-app/` root.
  base: "./",
  build: {
    // The workbench CSP refuses `data:` fonts.
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
    copyPublicDir: false,
    emptyOutDir: true,
    manifest: true,
    outDir: "dist/desktop",
    rollupOptions: {
      preserveEntrySignatures: "strict",
      input: {
        canvas: path.resolve(__dirname, "src/desktop-entry.tsx"),
      },
      output: canvasOutputNames,
    },
  },
});
