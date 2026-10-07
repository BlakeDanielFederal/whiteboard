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
    tms["ReviewWebTextModelService<br/>providers per scheme, newest first"]
    tm["ReviewWebTextMate<br/>TMGrammarFactory · TextMateTokenizationSupport"]
  end

  apisrc --> factories
  apisrc --> provider
  wb --> dvs
  webdiff --> factories
  websvc --> dvs
  tms --> provider
  dvs -- "structural snapshots provider" --> tms
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

## Canvas host seams

A host mounts the canvas with `mountReviewCanvas(container, content, ui)`.
What it can and cannot provide reaches the canvas through two optional
fields; a host that sets neither, such as Desktop, gets the full canvas.

```mermaid
flowchart LR
  host["Host (Desktop workbench · browser shell)"]
  host -- "bridge.capabilities.diffView" --> views["offeredReviewViews<br/>Diff tab offered or not"]
  views --> store["review panel store<br/>unoffered views land on the review"]
  host -- "ui.notify" --> copy["copyText failure reporter"]
  rid["randomId()<br/>getRandomValues fallback"] -. "plain-HTTP origins" .- host
```

## The web UI and its container

`whiteboard web` serves one origin: the review API, Ask, and the page built
into `packages/review/app/dist/web`. The Docker image packages all of it.

```mermaid
flowchart LR
  subgraph browser["Browser on the LAN (plain HTTP)"]
    entry["web-entry.tsx<br/>/ → Home · /reviews/:id → review"]
    bridge["WebCanvasBridge<br/>(src/web/web-canvas-bridge.ts)"]
    canvas["review-canvas (mountReviewCanvas)"]
    difflib["diff/reviewWebDiff.js<br/>(loaded at run time)"]
    entry --> canvas
    entry --> bridge
    bridge --> canvas
    bridge -- "inlineEditors · diffView" --> difflib
  end

  subgraph container["container whiteboard (docker/Dockerfile, node:24-bookworm-slim)"]
    host["whiteboard web --host 0.0.0.0 --software-maps<br/>DEV_REVIEW_SERVER_DIR=/data/server"]
    assets[("/opt/whiteboard/web")]
    agents["claude · codex · opencode (Ask)<br/>copilot (authoring)"]
    mcp["whiteboard mcp"]
    diffr["diffr (structural diff)"]
    host --> assets
    host --> agents
    host --> diffr
    mcp -- "DEV_REVIEW_SERVER_DIR=/data/server" --> host
  end

  hostagents["agents on the host<br/>MCP server whiteboard-docker"] -- "docker exec -i whiteboard whiteboard mcp" --> mcp

  browser -- "GET / · /assets · /diff · /reviews-api" --> host
  container --- data[("volume /data<br/>reviews · Ask · checkouts")]
  container --- repos[("bind $REPOS at its host path")]
  container --- home[("volume /home/node<br/>agent sign-ins")]
```
