import { shellQuote } from "@dev.fast/trace-core";
import type { AskTools } from "@review/ask/threads.js";

export interface AskCliEnv {
  name: string;
  value: string;
}

interface AskToolsInput {
  /** This server's own `whiteboard` CLI, once it is known. */
  cliPath: () => string | undefined;
  /** What pins that CLI to this server, so another running Whiteboard never answers it. */
  env: () => AskCliEnv[];
}

/**
 * Ask sessions get Whiteboard's MCP server, `whiteboard mcp`; an agent whose
 * model would not get it uses `whiteboard api` from its shell instead.
 */
export function createAskTools(input: AskToolsInput): AskTools {
  return {
    mcpServers: () => {
      const cliPath = input.cliPath();

      return cliPath
        ? [
            {
              name: "whiteboard",
              command: process.execPath,
              args: [cliPath, "mcp"],
              env: input.env(),
            },
          ]
        : [];
    },
    cli: () => {
      const cliPath = input.cliPath();

      return (
        cliPath &&
        [
          ...input
            .env()
            .map(({ name, value }) => `${name}=${shellQuote(value)}`),
          shellQuote(process.execPath),
          shellQuote(cliPath),
        ].join(" ")
      );
    },
  };
}
