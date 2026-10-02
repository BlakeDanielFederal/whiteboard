import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { syncOptionalExtensionCatalog } from "./optional-extension-catalog.mjs";

test("generated catalog loads updated install pins without rewriting unchanged output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "whiteboard-catalog-"));
  const file = path.join(root, "catalog.ts");

  const python = {
    id: "fixture.python",
    group: "python",
    role: "primary",
    version: "1.0.0",
    targets: {
      "darwin-arm64": {
        url: "https://example.invalid/python.vsix",
        sha256: "a".repeat(64),
        size: 123,
      },
    },
    developmentOnly: true,
  };

  try {
    await writeFile(
      file,
      'export const header = "retained";\nexport const reviewOptionalExtensionCatalog = [] as const;\n',
    );
    assert.throws(
      () =>
        syncOptionalExtensionCatalog({
          file,
          extensions: [python],
          check: true,
        }),
      /stale/,
    );
    syncOptionalExtensionCatalog({ file, extensions: [python] });
    syncOptionalExtensionCatalog({ file, extensions: [python], check: true });
    const first = await import(`${pathToFileURL(file).href}?first`);
    assert.equal(first.header, "retained");
    assert.equal(first.reviewOptionalExtensionCatalog.length, 1);
    const entry = first.reviewOptionalExtensionCatalog[0];
    assert.equal(entry.group, "python");
    assert.deepEqual(
      entry.targets["darwin-arm64"],
      python.targets["darwin-arm64"],
    );
    assert.equal("developmentOnly" in entry, false);

    await utimes(file, new Date(1000), new Date(1000));
    const before = await stat(file);
    syncOptionalExtensionCatalog({ file, extensions: [python] });
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);

    syncOptionalExtensionCatalog({
      file,
      extensions: [{ ...python, version: "2.0.0" }],
    });
    const updated = await import(`${pathToFileURL(file).href}?updated`);
    assert.equal(updated.reviewOptionalExtensionCatalog[0].version, "2.0.0");
    syncOptionalExtensionCatalog({ file, extensions: [] });
    const removed = await import(`${pathToFileURL(file).href}?removed`);
    assert.equal(removed.reviewOptionalExtensionCatalog.length, 0);

    await writeFile(file, "unexpected source");
    assert.throws(
      () => syncOptionalExtensionCatalog({ file, extensions: [] }),
      /export is missing/,
    );
    assert.equal(await readFile(file, "utf8"), "unexpected source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
