import { reviewFetchUrl } from "@canvas/host/review-client";
import {
  REVIEW_DISCORD_URL,
  type ReviewCanvasBridge,
  type ReviewDiffLayout,
  type ReviewDiffViewFactory,
  type ReviewDiffViewHandle,
  type ReviewDisposable,
  type ReviewInlineEditorFactory,
  type ReviewSourceView,
  type ReviewSurfaceEvent,
  type ReviewTheme,
  type ReviewVerbRequest,
  type ReviewVerbResponse,
  resolveReviewSourceView,
} from "@dev.fast/review-protocol";

/** The browser diff library (code-oss vs/review/web/reviewWebDiff.ts), loaded at run time. */
export interface WebDiffLibrary {
  forReview(view: () => ReviewSourceView): {
    inlineEditors: ReviewInlineEditorFactory;
    diffView: ReviewDiffViewFactory;
    openStructuralComparison(): void;
  };
  setTheme(theme: ReviewTheme): void;
  structuralDiffEnabled(): boolean;
  currentDiffLayout(): ReviewDiffLayout;
  setDiffLayout(layout: ReviewDiffLayout): Promise<void>;
  onDidChangeDiffLayout(
    listener: (layout: ReviewDiffLayout) => void,
  ): ReviewDisposable;
  onDidChangeSelection(
    listener: (
      event: Extract<ReviewSurfaceEvent, { event: "editorSelectionChanged" }>,
    ) => void,
  ): ReviewDisposable;
}

/** The page's light or dark preference, which the canvas and editors follow. */
export interface WebTheme {
  current(): ReviewTheme;
  onDidChange(listener: (theme: ReviewTheme) => void): ReviewDisposable;
}

export interface WebCanvasBridgeInput {
  serverUrl: string;
  reviewId: string;
  wasmUrl: string;
  appVersion: string;
  diff: WebDiffLibrary;
  theme: WebTheme;
  /** Opens another review in this page. */
  openReview(reviewId: string): void;
  openExternal(url: string): void;
}

// How long a reveal waits for the Diff view to mount its diff.
const DIFF_VIEW_WAIT_MS = 5_000;

/**
 * The canvas bridge for a browser. Requests go straight to the review server
 * this page came from; peeks and the Diff view come from the diff library;
 * what Desktop answers with a native window lands in the Diff view instead.
 */
export interface WebCanvasBridge {
  bridge: ReviewCanvasBridge;
  /** The canvas reports the review's source view, as it does to Desktop. */
  setSourceView(view: ReviewSourceView): void;
}

export function createWebCanvasBridge(
  input: WebCanvasBridgeInput,
): WebCanvasBridge {
  let view = resolveReviewSourceView({
    reviewId: input.reviewId,
    version: 0,
    pins: {},
  });

  const source = input.diff.forReview(() => view);
  const listeners = new Set<(event: ReviewSurfaceEvent) => void>();
  let diffHandle: ReviewDiffViewHandle | undefined;
  const handleWaiters = new Set<(handle: ReviewDiffViewHandle) => void>();

  const emit = (event: ReviewSurfaceEvent) => {
    for (const listener of listeners) listener(event);
  };

  /** Shows the Diff view and resolves with its diff once it is mounted. */
  const showDiff = async () => {
    emit({ event: "showReviewView", view: "diff" });

    if (diffHandle) return diffHandle;

    return new Promise<ReviewDiffViewHandle | undefined>((resolve) => {
      const timer = setTimeout(() => {
        handleWaiters.delete(waiter);
        resolve(undefined);
      }, DIFF_VIEW_WAIT_MS);

      const waiter = (handle: ReviewDiffViewHandle) => {
        clearTimeout(timer);
        handleWaiters.delete(waiter);
        resolve(handle);
      };

      handleWaiters.add(waiter);
    });
  };

  const diffView: ReviewDiffViewFactory = {
    files: source.diffView.files,
    create(spec) {
      const handle = source.diffView.create(spec);

      // A document embed is not the Diff view; only the Diff view is revealed into.
      if (!spec.document) {
        diffHandle = handle;

        for (const waiter of [...handleWaiters]) waiter(handle);
      }

      return {
        ...handle,
        focus: () => handle.focus(),
        onDidError: (listener) => handle.onDidError(listener),
        dispose() {
          if (diffHandle === handle) diffHandle = undefined;
          handle.dispose();
        },
      };
    },
  };

  const post = async (
    request: ReviewVerbRequest,
  ): Promise<ReviewVerbResponse> => {
    switch (request.name) {
      case "showReviewView":
        emit({ event: "showReviewView", view: request.args.view });
        break;
      case "openDiff":
        (await showDiff())?.revealFile?.(request.args.path);
        break;
      case "reveal": {
        const handle = await showDiff();

        handle?.revealFile?.(request.args.path);
        handle?.revealSource?.({
          file: request.args.path,
          side: request.args.side ?? "head",
          fromLine: request.args.startLine,
          toLine: request.args.endLine,
        });

        break;
      }

      case "openReview":
        input.openReview(request.args.reviewUuid);
        break;
      case "openApiReview":
        input.openReview(request.args.reviewId);
        break;
      case "joinDiscord":
        input.openExternal(REVIEW_DISCORD_URL);
        break;
      // Window focus, screenshots, the source tree and authoring capabilities
      // belong to Desktop; a browser has nothing to do for them.
      default:
        break;
    }

    return { ok: true };
  };

  const bridge: ReviewCanvasBridge = {
    config: {
      serverUrl: input.serverUrl,
      reviewId: input.reviewId,
      token: "",
      wasmUrl: input.wasmUrl,
      appVersion: input.appVersion,
      theme: input.theme.current(),
      host: "web",
    },
    // The source tree is a native window of Desktop's.
    capabilities: { sourceTree: false },
    inlineEditors: source.inlineEditors,
    diffView,
    request: (url, init) =>
      reviewFetchUrl({ serverUrl: input.serverUrl }, url, init),
    post,
    subscribe(listener) {
      listeners.add(listener);

      // A selection is this review's when its editor reads this review.
      const selection = input.diff.onDidChangeSelection((event) => {
        if (event.reviewId === input.reviewId) listener(event);
      });

      return {
        dispose() {
          listeners.delete(listener);
          selection.dispose();
        },
      };
    },
    currentTheme: () => input.theme.current(),
    onDidChangeTheme: (listener) => input.theme.onDidChange(listener),
    currentDiffLayout: () => input.diff.currentDiffLayout(),
    setDiffLayout: (layout) => input.diff.setDiffLayout(layout),
    onDidChangeDiffLayout: (listener) =>
      input.diff.onDidChangeDiffLayout(listener),
    ready() {},
  };

  return {
    bridge,
    setSourceView(next) {
      view = next;
      source.openStructuralComparison();
    },
  };
}
