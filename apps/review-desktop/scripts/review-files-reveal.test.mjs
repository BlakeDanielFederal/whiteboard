import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));

test("Review Files reveals only available items and retires unavailable or superseded requests", () => {
  execFileSync(
    process.execPath,
    [
      "--import", "tsx", "--input-type=module", "-e",
      String.raw`
    import assert from "node:assert/strict";
    import { createRequire, registerHooks } from "node:module";
    const require = createRequire(new URL("./package.json", import.meta.url));
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM("<html><body></body></html>", { pretendToBeVisual: true });
    for (const key of ["window", "document", "HTMLElement", "HTMLCanvasElement", "Node", "MutationObserver", "Element", "navigator", "customElements", "UIEvent", "MouseEvent", "KeyboardEvent"]) {
      Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
    }
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    process.noDeprecation = true;
    registerHooks({ load(url, context, next) {
      if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
      return next(url, context);
    } });

    const native = "./code-oss/src/vs/";
    const { ReviewFilesDiffView } = await import(native + "review/services/reviewFilesDiffView.ts");
    const { DisposableStore, MutableDisposable } = await import(native + "base/common/lifecycle.ts");
    const { Event } = await import(native + "base/common/event.ts");
    const { observableValue } = await import(native + "base/common/observable.ts");
    const { URI } = await import(native + "base/common/uri.ts");

    const entry = path => ({
      file: { path, status: "modified" },
      original: URI.parse("test:/base/" + path),
      modified: URI.parse("test:/head/" + path),
    });
    const item = entry => ({
      originalUri: entry.original, modifiedUri: entry.modified,
      collapsed: { set() {} },
    });
    async function harness(entries) {
      const store = new DisposableStore();
      const items = observableValue("test items", []);
      const loading = observableValue("test loading", true);
      const settled = observableValue("test settled", false);
      const reveals = [];
      const fileStates = [];
      const view = Object.create(ReviewFilesDiffView.prototype);
      Object.assign(view, {
        _store: store,
        settleHold: store.add(new MutableDisposable()),
        root: document.createElement("div"),
        readyFiles: new Set(), fileStates: new Map(),
        hiddenFiles: new Map(), hiddenApplied: new Set(), viewedApplied: new Map(),
        initializedDocumentItems: new WeakSet(),
        changedFilesTree: {
          setFiles() {},
          setFileState(path, state, message) { fileStates.push({ path, state, message }); },
        },
        streamStatus: document.createElement("div"),
        diffContainer: document.createElement("div"),
        widget: {
          setViewModel() {}, getActiveItem() { return undefined; },
          onDidChangeContentHeight: Event.None,
          reveal(resource, options) {
            assert.ok(items.get().some(i => i.originalUri.toString() === resource.original.toString()), "widget only receives a loaded item");
            reveals.push({ path: entries.find(e => e.original.toString() === resource.original.toString()).file.path, options });
          },
        },
      });
      const input = {
        entries, resourcesSettled: settled,
        getViewModel: async () => ({ items, isLoading: loading }),
        setReadyFiles() {},
      };
      await view.setInput(input);
      return { view, store, items, loading, settled, reveals, fileStates };
    }

    try {
      const a = entry("a.ts"), b = entry("b.ts");
      {
        const h = await harness([a, b]);
        try {
          h.view.revealFile("a.ts");
          h.items.set([item(b)], undefined);
          h.loading.set(false, undefined);
          await Promise.resolve();
          assert.deepEqual(h.reveals, [], "another ready file must not terminate the requested reveal");
          h.items.set([item(a), item(b)], undefined);
          await Promise.resolve();
          assert.deepEqual(h.reveals.map(r => r.path), ["a.ts"]);
        } finally { h.store.dispose(); }
      }
      {
        const h = await harness([a, b]);
        try {
          h.view.revealFile("a.ts");
          h.items.set([item(b)], undefined);
          h.loading.set(false, undefined);
          await Promise.resolve();
          assert.deepEqual(h.fileStates, [], "a pending model reference is not unavailable yet");
          h.settled.set(true, undefined);
          assert.deepEqual(h.fileStates, [{ path: "a.ts", state: "error", message: "Diff unavailable" }]);
          assert.equal(h.view.streamStatus.textContent, "a.ts: Diff unavailable");
          assert.deepEqual(h.reveals, []);
          h.view.revealFile("b.ts");
          await Promise.resolve();
          assert.deepEqual(h.reveals.map(r => r.path), ["b.ts"]);
          assert.equal(h.view.streamStatus.hidden, true, "an older missing file must not obscure the next file");
        } finally { h.store.dispose(); }
      }
      {
        const h = await harness([a, b]);
        try {
          h.view.revealFile("a.ts");
          h.items.set([item(a)], undefined); // queues the reveal in a microtask
          h.view.revealFile("b.ts"); // supersedes it before that microtask runs
          h.items.set([item(a), item(b)], undefined);
          await Promise.resolve();
          assert.deepEqual(h.reveals.map(r => r.path), ["b.ts"]);
        } finally { h.store.dispose(); }
      }
      {
        const h = await harness([a]);
        try {
          h.view.startLoading([a]);
          h.view.revealFile("a.ts");
          h.view.fileLoaded("a.ts", "Source unavailable");
          assert.deepEqual(h.reveals, []);
          assert.equal(h.view.streamStatus.textContent, "a.ts: Source unavailable");
          assert.equal(h.view.pendingReveal, undefined);
        } finally { h.store.dispose(); }
      }
      {
        const h = await harness([a]);
        try {
          h.view.revealSource({ file: "a.ts", side: "head", fromLine: 3, toLine: 4 });
          h.items.set([item(a)], undefined);
          await Promise.resolve();
          assert.deepEqual(h.reveals.map(r => [r.path, r.options.side, r.options.range.startLineNumber]), [["a.ts", "modified", 3]]);
        } finally { h.store.dispose(); }
      }
      {
        const h = await harness([a]);
        h.view.revealSource({ file: "a.ts", side: "head", fromLine: 3, toLine: 4 });
        h.items.set([item(a)], undefined);
        h.store.dispose(); // navigation tears down the view before the queued reveal
        await Promise.resolve();
        assert.deepEqual(h.reveals, []);
      }
    } finally { dom.window.close(); }
  `,
    ],
    {
      cwd: desktopRoot,
      env: { ...process.env, TSX_TSCONFIG_PATH: "tsconfig.test.json" },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
});
