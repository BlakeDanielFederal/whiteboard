import { mountReviewCanvas } from "@canvas/desktop-entry";
import { reviewFetchUrl } from "@canvas/host/review-client";
// The browser UI the web host serves: Home at `/`, a review at `/reviews/<id>`.
import {
  ReviewApiClient,
  type ReviewApiSummary,
  type ReviewCanvasContent,
  type ReviewCanvasHandle,
  type ReviewCanvasUi,
  type ReviewMenuRequest,
  type ReviewTheme,
} from "@dev.fast/review-protocol";

import {
  type WebDiffLibrary,
  type WebTheme,
  createWebCanvasBridge,
} from "./web-canvas-bridge";

// The libavoid edge router, emitted beside the canvas as Desktop's build emits it.
const wasmUrl = new URL(
  "../../../../../node_modules/@mr_mint/elkjs-libavoid/dist/libavoid.wasm",
  import.meta.url,
).href;

const serverUrl = location.origin;

const request = (url: string, init?: RequestInit) =>
  reviewFetchUrl({ serverUrl }, url, init);

const client = new ReviewApiClient({ serverUrl, token: "" }, request);

const REVIEW_PATH = /^\/reviews\/([^/]+)\/?$/;

const container = document.getElementById("whiteboard")!;

const theme = pageTheme();

const ui: ReviewCanvasUi = {
  showMenu,
  notify: ({ kind, text }) => toast(kind, text),
  confirmDelete: async (title) =>
    confirm(`Delete “${title}”? This cannot be undone.`),
};

const diff = await loadDiffLibrary();

const capabilities = await client
  .read<{ softwareMapEnabled?: boolean }>("/capabilities")
  .catch(() => ({ softwareMapEnabled: false }));

let canvas: ReviewCanvasHandle | undefined;

let leaveRoute: (() => void) | undefined;

theme.onDidChange((next) => diff.setTheme(next));

window.addEventListener("popstate", () => void route());

await route();

async function route() {
  leaveRoute?.();
  leaveRoute = undefined;

  const reviewId = REVIEW_PATH.exec(location.pathname)?.[1];

  if (reviewId) openReview(decodeURIComponent(reviewId));
  else await openHome();
}

function navigate(pathname: string) {
  if (location.pathname === pathname) return;
  history.pushState(null, "", pathname);
  void route();
}

function show(content: ReviewCanvasContent) {
  if (canvas) canvas.update(content);
  else canvas = mountReviewCanvas(container, content, ui);
}

async function openHome() {
  document.title = "Whiteboard";
  const abort = new AbortController();
  leaveRoute = () => abort.abort();

  const mode = diff.structuralDiffEnabled() ? "structural" : "textual";

  const render = (reviews: readonly ReviewApiSummary[]) => {
    if (abort.signal.aborted) return;
    show({
      kind: "home",
      reviews,
      openReview: (reviewId) =>
        navigate(`/reviews/${encodeURIComponent(reviewId)}`),
      deleteReview: async (reviewId) => {
        await client.post("/commands", {
          operation: { type: "delete", reviewId },
        });
      },
      dismissReview: (reviewId) => attention(reviewId, "dismiss"),
      restoreReview: (reviewId) => attention(reviewId, "restore"),
      // The tutorial checks out a sample repository beside Desktop; not offered here.
      openTutorial: () => {},
    });
  };

  render(await client.read<ReviewApiSummary[]>(`?mode=${mode}`, abort.signal));
  void client.follow<ReviewApiSummary[]>(
    null,
    abort.signal,
    render,
    (cause) => console.warn("[Whiteboard] Review list disconnected:", cause),
    mode,
  );
}

function openReview(reviewId: string) {
  const { bridge, setSourceView } = createWebCanvasBridge({
    serverUrl,
    reviewId,
    wasmUrl,
    appVersion: "web",
    diff,
    theme,
    openReview: (next) => navigate(`/reviews/${encodeURIComponent(next)}`),
    openExternal: (url) => void window.open(url, "_blank", "noopener"),
  });

  void attention(reviewId, "view").catch(() => {});
  show({
    kind: "api",
    reviewId,
    bridge,
    structuralDiffEnabled: diff.structuralDiffEnabled(),
    softwareMapEnabled: capabilities.softwareMapEnabled === true,
    setTitle: (title) => (document.title = `${title} · Whiteboard`),
    setSourceView: (_selection, view) => setSourceView(view),
  });
}

async function attention(
  reviewId: string,
  action: "view" | "dismiss" | "restore",
): Promise<void> {
  await client.post("/commands", {
    operation: { type: "attention", reviewId, action },
  });
}

async function loadDiffLibrary(): Promise<WebDiffLibrary> {
  const library: {
    createReviewWebDiff(options: {
      serverUrl: string;
      theme: ReviewTheme;
    }): WebDiffLibrary;
  } = await import(
    /* @vite-ignore */ new URL("/diff/reviewWebDiff.js", location.href).href
  );

  return library.createReviewWebDiff({ serverUrl, theme: theme.current() });
}

function pageTheme(): WebTheme {
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const current = (): ReviewTheme => (dark.matches ? "dark" : "light");
  const listeners = new Set<(theme: ReviewTheme) => void>();

  dark.addEventListener("change", () => {
    for (const listener of listeners) listener(current());
  });

  return {
    current,
    onDidChange(listener) {
      listeners.add(listener);

      return { dispose: () => void listeners.delete(listener) };
    },
  };
}

/** A plain popup menu under its anchor, for the canvas's dropdowns. */
function showMenu(request: ReviewMenuRequest) {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.className = "whiteboard-web-menu";
  const anchor = request.anchor.getBoundingClientRect();
  menu.style.top = `${anchor.bottom + 4}px`;
  menu.style.left = `${anchor.left}px`;

  for (const item of request.items) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(
      "role",
      item.checked === undefined ? "menuitem" : "menuitemcheckbox",
    );

    if (item.checked !== undefined)
      button.setAttribute("aria-checked", String(item.checked));
    button.disabled = item.enabled === false;
    button.textContent = `${item.checked ? "✓ " : ""}${item.label}`;
    button.addEventListener("click", () => {
      hide();
      void request.onSelect(item.id);
    });
    menu.append(button);
  }

  const outside = (event: Event) => {
    if (!(event.target instanceof Node && menu.contains(event.target))) hide();
  };

  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") hide();
  };

  let hidden = false;

  function hide() {
    if (hidden) return;
    hidden = true;
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", escape, true);
    request.onHide();
  }

  document.body.append(menu);
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", escape, true);
  menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();

  return { dispose: hide };
}

function toast(kind: "success" | "error", text: string) {
  const element = document.createElement("div");
  element.className = `whiteboard-web-toast whiteboard-web-toast-${kind}`;
  element.setAttribute("role", kind === "error" ? "alert" : "status");
  element.textContent = text;
  document.body.append(element);
  setTimeout(() => element.remove(), 4_000);
}
