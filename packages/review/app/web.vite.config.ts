import path from "node:path";

import { defineConfig } from "vite";

import { canvasOutputNames, canvasPlugins, canvasResolve } from "./canvas-vite";
import { stylexOptions } from "./stylex-options";

// The browser UI the web host serves: the page owns the whole document, so the
// canvas CSS is not scoped (`@scope` is newer than some browsers on a LAN).
// The diff library is built separately into dist/web/diff.
export default defineConfig({
  root: path.join(__dirname, "web"),
  plugins: canvasPlugins({
    ...stylexOptions,
    // Current Chrome, Safari and Firefox rather than Desktop's Chromium.
    lightningcssOptions: {
      targets: { chrome: 120 << 16, safari: 17 << 16, firefox: 128 << 16 },
      minify: true,
    },
  }),
  resolve: canvasResolve,
  base: "/",
  build: {
    // The page entry awaits the diff library at the top level.
    target: "es2022",
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
    copyPublicDir: false,
    emptyOutDir: true,
    outDir: path.join(__dirname, "dist/web"),
    rollupOptions: { output: canvasOutputNames },
  },
});
