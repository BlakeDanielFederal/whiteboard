import { createRequire } from "node:module";
import path from "node:path";

import stylex, { type UserOptions } from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import type { PluginOption, UserConfig } from "vite";

import { sourceAliases } from "../test-config";
import {
  hardenLibavoidForTrustedTypes,
  isLibavoidBrowserModule,
} from "./desktop-trusted-types";

const require = createRequire(import.meta.url);

const decodeNamedCharacterReferenceIndex = path.join(
  path.dirname(require.resolve("decode-named-character-reference")),
  "index.js",
);

/** The canvas's build plugins, shared by the Desktop and web builds. */
export function canvasPlugins(
  stylexOptions: Partial<UserOptions>,
): PluginOption[] {
  return [
    // Appends the collected StyleX rules to the canvas CSS asset in its own
    // generateBundle, which runs before any later CSS plugin.
    stylex.vite(stylexOptions),
    {
      name: "harden-libavoid-trusted-types",
      enforce: "pre",
      transform(source, moduleId) {
        if (!isLibavoidBrowserModule(moduleId)) return;

        return {
          code: hardenLibavoidForTrustedTypes(source),
          map: null,
        };
      },
    },
    {
      // Chromium reads woff2; drop KaTeX's woff and ttf fallbacks.
      name: "katex-woff2-only",
      enforce: "pre",
      transform(source, moduleId) {
        if (!/[/\\]katex[/\\]dist[/\\]katex\.css$/.test(moduleId)) return;

        return {
          code: source.replaceAll(
            /, url\([^)]+\) format\("(?:woff|truetype)"\)/g,
            "",
          ),
          map: null,
        };
      },
    },
    react(),
  ];
}

export const canvasResolve: UserConfig["resolve"] = {
  dedupe: ["react", "react-dom"],
  alias: {
    ...sourceAliases,
    "decode-named-character-reference": decodeNamedCharacterReferenceIndex,
  },
};

export const canvasOutputNames = {
  entryFileNames: "assets/[name]-[hash].js",
  chunkFileNames: "assets/[name]-[hash].js",
  assetFileNames: "assets/[name]-[hash][extname]",
};
