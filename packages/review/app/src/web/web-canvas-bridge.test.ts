import type {
  ReviewDiffLayout,
  ReviewDiffViewHandle,
  ReviewDiffViewSpec,
  ReviewSurfaceEvent,
  ReviewTheme,
} from "@dev.fast/review-protocol";
import { expect, it, vi } from "vitest";

import {
  type WebDiffLibrary,
  type WebTheme,
  createWebCanvasBridge,
} from "./web-canvas-bridge";

function diffHandle(): ReviewDiffViewHandle {
  return {
    focus() {},
    onDidError: () => ({ dispose() {} }),
    revealFile: vi.fn<NonNullable<ReviewDiffViewHandle["revealFile"]>>(),
    revealSource: vi.fn<NonNullable<ReviewDiffViewHandle["revealSource"]>>(),
    dispose() {},
  };
}

type SelectionEvent = Extract<
  ReviewSurfaceEvent,
  { event: "editorSelectionChanged" }
>;

function setup() {
  const handle = diffHandle();
  const selectionListeners = new Set<(event: SelectionEvent) => void>();
  const themeListeners = new Set<(theme: ReviewTheme) => void>();
  let currentTheme: ReviewTheme = "light";

  const diff: WebDiffLibrary = {
    forReview: () => ({
      inlineEditors: {
        create: () => {
          throw new Error("no peeks in this test");
        },
        find: async () => ({ matchCount: 0 }),
      },
      diffView: { files: async () => [], create: () => handle },
      openStructuralComparison() {},
    }),
    setTheme() {},
    structuralDiffEnabled: () => true,
    currentDiffLayout: (): ReviewDiffLayout => "split",
    setDiffLayout: async () => {},
    onDidChangeDiffLayout: () => ({ dispose() {} }),
    onDidChangeSelection(listener) {
      selectionListeners.add(listener);

      return { dispose: () => void selectionListeners.delete(listener) };
    },
  };

  const theme: WebTheme = {
    current: () => currentTheme,
    onDidChange(listener) {
      themeListeners.add(listener);

      return { dispose: () => void themeListeners.delete(listener) };
    },
  };

  const openReview = vi.fn<(reviewId: string) => void>();
  const openExternal = vi.fn<(url: string) => void>();

  const { bridge } = createWebCanvasBridge({
    serverUrl: "http://192.168.1.20:8080",
    reviewId: "review-1",
    wasmUrl: "http://192.168.1.20:8080/assets/libavoid.wasm",
    appVersion: "web",
    diff,
    theme,
    openReview,
    openExternal,
  });

  const events: ReviewSurfaceEvent[] = [];
  bridge.subscribe((event) => events.push(event));

  const setTheme = (next: ReviewTheme) => {
    currentTheme = next;

    for (const listener of themeListeners) listener(next);
  };

  // What the Diff view does when the canvas shows it.
  const mountDiffView = () =>
    bridge.diffView.create({
      container: {} as HTMLElement,
    } satisfies Partial<ReviewDiffViewSpec> as ReviewDiffViewSpec);

  const select = (reviewId: string) => {
    for (const listener of selectionListeners)
      listener({
        event: "editorSelectionChanged",
        reviewId,
        path: "src/one.ts",
        range: { fromLine: 1, toLine: 2 },
        sideContext: "head",
        isEmpty: false,
      });
  };

  return {
    bridge,
    handle,
    select,
    events,
    openReview,
    openExternal,
    setTheme,
    mountDiffView,
  };
}

it("reveals a source range in the Diff view", async () => {
  const { bridge, handle, events, mountDiffView } = setup();

  const reveal = bridge.post({
    name: "reveal",
    args: {
      path: "src/one.ts",
      startLine: 3,
      endLine: 7,
      side: "base",
      highlight: true,
      preserveFocus: false,
    },
  });

  expect(events).toEqual([{ event: "showReviewView", view: "diff" }]);
  mountDiffView();

  expect(await reveal).toEqual({ ok: true });
  expect(handle.revealFile).toHaveBeenCalledWith("src/one.ts");
  expect(handle.revealSource).toHaveBeenCalledWith({
    file: "src/one.ts",
    side: "base",
    fromLine: 3,
    toLine: 7,
  });
});

it("opens a file's diff in the Diff view it already shows", async () => {
  const { bridge, handle, mountDiffView } = setup();

  mountDiffView();
  await bridge.post({ name: "openDiff", args: { path: "src/two.ts" } });

  expect(handle.revealFile).toHaveBeenCalledWith("src/two.ts");
});

it("opens another review in the page", async () => {
  const { bridge, openReview } = setup();

  await bridge.post({
    name: "openReview",
    args: { reviewUuid: "6dcbc266-3af3-45cb-9032-8f85ffde4de0", active: true },
  });

  expect(openReview).toHaveBeenCalledWith(
    "6dcbc266-3af3-45cb-9032-8f85ffde4de0",
  );
});

it("accepts desktop-only requests and does nothing", async () => {
  const { bridge, events, openReview, openExternal } = setup();

  expect(await bridge.post({ name: "focusWindow", args: {} })).toEqual({
    ok: true,
  });
  expect(await bridge.post({ name: "openSourceTree", args: {} })).toEqual({
    ok: true,
  });
  expect(events).toEqual([]);
  expect(openReview).not.toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();
});

it("passes the reader's code selection in this review to the canvas, for Ask", () => {
  const { events, select } = setup();

  select("review-1");
  select("another-review");

  expect(events).toEqual([
    expect.objectContaining({
      event: "editorSelectionChanged",
      reviewId: "review-1",
      path: "src/one.ts",
    }),
  ]);
});

it("follows the page's color scheme", () => {
  const { bridge, setTheme } = setup();
  const seen: ReviewTheme[] = [];

  bridge.onDidChangeTheme((theme) => seen.push(theme));
  setTheme("dark");

  expect(seen).toEqual(["dark"]);
  expect(bridge.currentTheme()).toBe("dark");
  expect(bridge.config).toMatchObject({
    host: "web",
    serverUrl: "http://192.168.1.20:8080",
    token: "",
  });
});
