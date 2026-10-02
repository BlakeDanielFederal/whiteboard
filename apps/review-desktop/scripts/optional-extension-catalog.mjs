import { readFileSync, writeFileSync } from "node:fs";

import { optionalExtensions } from "./curated-extensions.manifest.mjs";

export function syncOptionalExtensionCatalog({
  file = new URL(
    "../code-oss/src/vs/review/node/reviewOptionalExtensionCatalog.ts",
    import.meta.url,
  ),
  extensions = optionalExtensions,
  check = false,
} = {}) {
  const current = readFileSync(file, "utf8");
  const start = current.indexOf("export const reviewOptionalExtensionCatalog");

  if (start < 0)
    throw new Error("Optional extension catalog export is missing");

  const catalog = extensions.map(({ id, role, group, version, targets }) => ({
    id,
    role,
    group,
    version,
    targets,
  }));

  const source =
    current.slice(0, start) +
    "export const reviewOptionalExtensionCatalog = " +
    JSON.stringify(catalog, null, "\t") +
    ' as const;\n\nexport type ReviewOptionalExtension = (typeof reviewOptionalExtensionCatalog)[number];\nexport type ReviewOptionalExtensionTarget = keyof ReviewOptionalExtension["targets"];\n';

  if (current !== source) {
    if (check)
      throw new Error("Optional extension catalog is stale; run protocol:sync");
    writeFileSync(file, source);
  }
}
