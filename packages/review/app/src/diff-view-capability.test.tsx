// @vitest-environment jsdom
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  ReviewCanvasBridge,
  ReviewSurfaceEvent,
} from "@dev.fast/review-protocol";
import { createReviewApi } from "@review/review-api/http";
import { ReviewStore } from "@review/review-api/store";
import { Hono } from "hono";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { mountReviewCanvas as mount } from "./desktop-entry";
import { testReviewBridge } from "./review-session-test-utils";
import { writeReviewUiState } from "./review-ui-state";
import { reviewViewStateKey } from "./review-view-state";

let store: ReviewStore, directory: string;

let canvas: ReturnType<typeof mount> | undefined;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  directory = mkdtempSync(path.join(tmpdir(), "review-diff-capability-"));
  store = new ReviewStore(path.join(directory, "review.db"), {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(async () => {
  await act(async () => canvas?.dispose());
  canvas = undefined;
  await store.close();
  document.body.innerHTML = "";
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

/** Opens a review of a change range, on the Diff view if the reader left it there. */
async function open(capabilities?: ReviewCanvasBridge["capabilities"]) {
  const review = await store.execute({
    operation: {
      type: "create",
      title: "Capability review",
      target: {
        kind: "commits",
        repositoryId: "repo",
        base: "base",
        head: "head",
      },
    },
  });

  const app = new Hono();
  app.route("/reviews-api", createReviewApi(store));
  app.get("/reviews-api/:id/commits", (context) => context.json([]));

  const listeners = new Set<(event: ReviewSurfaceEvent) => void>();

  const bridge: ReviewCanvasBridge = {
    ...testReviewBridge(
      {},
      {
        request: async (url, init) => app.request(url, init),
        subscribe: (listener) => {
          listeners.add(listener);

          return { dispose: () => void listeners.delete(listener) };
        },
      },
    ),
    capabilities,
  };

  writeReviewUiState("session", reviewViewStateKey(bridge.config), {
    activeView: "diff",
  });

  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    canvas = mount(container, {
      kind: "api",
      reviewId: review.reviewId,
      bridge,
    });
  });
  await act(async () => {
    await vi.waitFor(() => expect(tab(container, "Commits")).toBeTruthy());
  });

  const emit = (event: ReviewSurfaceEvent) =>
    act(async () => listeners.forEach((listener) => listener(event)));

  return { container, emit };
}

it("hides the Diff view from a host that cannot show diffs", async () => {
  const { container, emit } = await open({ diffView: false });

  expect(tab(container, "Diff")).toBeNull();
  // A reader who left the review on the Diff view comes back to the review.
  expect(tab(container, "Whiteboard")?.getAttribute("aria-pressed")).toBe(
    "true",
  );

  await emit({ event: "showReviewView", view: "diff" });

  expect(tab(container, "Whiteboard")?.getAttribute("aria-pressed")).toBe(
    "true",
  );
});

it("keeps the Diff view for a host that declares nothing, as Desktop does", async () => {
  const { container } = await open();

  expect(tab(container, "Diff")?.getAttribute("aria-pressed")).toBe("true");
});

function tab(container: HTMLElement, label: string) {
  return container.querySelector<HTMLButtonElement>(
    `[aria-label="Session views"] button[aria-label="${label}"]`,
  );
}
