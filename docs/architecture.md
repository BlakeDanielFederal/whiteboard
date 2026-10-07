# Architecture

## Review diff rendering: Desktop and browser

Code peeks, the Diff view, lenses and structural diff are one implementation,
`ReviewDiffViewService` in the Code OSS fork. Desktop runs it inside the
workbench; the browser diff library runs the same classes on upstream's
standalone editor services.

```mermaid
flowchart LR
  subgraph canvas["review-canvas (React)"]
    peek["CodePeek / DocumentCodeView"]
    difftab["Diff view"]
  end

  peek -- "bridge.inlineEditors" --> factories
  difftab -- "bridge.diffView" --> factories

  subgraph shared["code-oss/src/vs/review/services"]
    factories["reviewCanvasDiffFactories<br/>(reviewApiSourceContent.ts)"]
    provider["reviewApiSourceContentProvider"]
    dvs["ReviewDiffViewService<br/>ReviewFilesDiffView · lenses · StructuralDiffSession"]
    factories --> dvs
  end

  subgraph desktop["Desktop (Electron workbench)"]
    apisrc["ReviewApiSourceService"]
    wb["workbench services"]
  end

  subgraph web["Browser diff library (vs/review/web)"]
    webdiff["createReviewWebDiff"]
    websvc["createReviewWebServices<br/>StandaloneServices + 7 stubs"]
    tms["ReviewWebTextModelService"]
    tm["ReviewWebTextMate<br/>TMGrammarFactory · TextMateTokenizationSupport"]
  end

  apisrc --> factories
  apisrc --> provider
  wb --> dvs
  webdiff --> factories
  websvc --> dvs
  tms --> provider
  websvc --> tm
  tm -- "grammars/*, onig.wasm (lazy)" --> assets[("bundle assets")]

  provider -- "GET /reviews-api/:id/file" --> server[("review server")]
  factories -- "GET /:id/diff · /:id/structural-diff" --> server
```

## Building the browser diff library

```mermaid
flowchart LR
  src["code-oss/src/vs/review/web/reviewWebDiff.ts"] --> build["apps/review-desktop/scripts/build-web-diff.mjs<br/>(esbuild)"]
  worker["vs/editor/common/services/editorWebWorkerMain.ts"] --> build
  themes["extensions/review-themes (Whiteboard Light/Dark)"] -- "colors + tokenColors, include chain resolved" --> build
  langs["extensions/*/package.json<br/>languages · grammars"] -- "language list; grammar files copied" --> build
  build --> out["packages/review/app/dist/web/diff/<br/>reviewWebDiff.js · workerMain.js · reviewWebDiff.css · media/ · grammars/ · onig.wasm"]
```

## Review servers

Every host builds the same core. Hosts differ in who may call them and in
what they add around it.

```mermaid
flowchart TB
  core["createWhiteboardCore<br/>(server/review-server-core.ts)<br/>CORS · /health · auth · /control · /reviews-api"]
  access{{"access: token | open"}}
  core --- access

  desktop["desktop-server.ts<br/>(Desktop's Node host)"] -- "access: token" --> core
  headless["headless-host.ts<br/>(whiteboard server start)"] -- "access: token" --> core
  web["web-host.ts<br/>(whiteboard web)<br/>static UI from --assets · SPA fallback"] -- "access: open" --> core
  lock[("state-dir lock + discovery record")]
  headless --- lock
  web --- lock

  asktools["createAskTools<br/>(server/ask-tools.ts)<br/>whiteboard mcp · CLI fallback"]
  desktop -- "ask: { tools }" --> asktools
  web -- "ask: { tools }<br/>DEV_REVIEW_SERVER_DIR pins the CLI" --> asktools
```
