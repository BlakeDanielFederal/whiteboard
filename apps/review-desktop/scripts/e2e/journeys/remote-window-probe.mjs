/** A Source window bound to a remote host: the probe extension on the host tries every guarded action from that window's extension host. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  closeSourceWindow,
  openHome,
  openSettings,
  sourceWindowFor,
} from "../harness.mjs";
import { alias, onRemote, remote, runDir } from "./remote-host.mjs";
import { lines, pointerHover } from "./remote-lsp.mjs";

const exec = promisify(execFile);

const probeDir = path.join(import.meta.dirname, "../remote/probe-extension");

const probeHome =
  "$HOME/.dev/whiteboard-remote/extensions/wb-test.remote-guard-probe-0.0.1";

const title = "Remote probe";

// A well-formed authority no host has: the guard must refuse it as not its own.
const otherAuthority = "whiteboard+00000000-0000-4000-8000-000000000000";

const hostile = {
  "editor.fontSize": 40,
  "files.readonlyInclude": { "**/*": false },
  "files.readonlyExclude": { "**/*": true },
  "window.title": "wb probe hostile title",
};

// What the probe on the host must see refused, in its source-probe.log.
const REFUSED = [
  "read vscode-local:/etc/hosts",
  "read the other remote's /etc/hosts",
  "openExternal file:///tmp/wb-probe-marker.command",
  "executeCommand vscode.openFolder",
  "clipboard.readText",
  "clipboard.writeText",
  "update a global setting",
  "download a URL",
  "applyEdit on the laptop",
  "edit this remote's editor",
  "insertSnippet in this remote's editor",
  "read the laptop's settings.json through vscode-local",
  "openTextDocument on the laptop's settings.json",
  "openTextDocument on the laptop's empty Source side",
  "see the laptop's open documents",
  "see the window's commands",
  "executeCommand workbench.action.quickOpen with arguments",
  "findFiles in a laptop folder",
  "findTextInFiles in a laptop folder",
  "findFiles on another host",
  "text search learns a laptop buffer (results or limitHit)",
  "applyEdit on this remote's checkout",
  "read back editor.fontSize from .vscode/settings.json",
  "workspace.fs.writeFile on a laptop file through vscode-local",
  "workspace.fs.writeFile on another host's file",
  "workspace.fs.writeFile on the laptop's empty Source side",
  "workspace.fs.delete on a laptop file",
  "workspace.fs.rename on a laptop file",
];

export const name = "remote-window-probe";

// Phase 2: the container image downloads Ubuntu packages and Node.
export const phase = 2;

export const options = {
  settings: { "review.experimental.remoteHosts.enabled": true },
  env: { DEV_FAST_REVIEW_SSH_CONFIG: `${runDir}/ssh_config` },
};

/** Runs on the remote: a repository whose .vscode/settings.json is hostile, and a review of its second commit. Prints the review's id. */
const fixture = String.raw`
set -e
field() { node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8')).$1"; }
rm -rf ~/wbprobe
git init -q -b main ~/wbprobe
cd ~/wbprobe
git config user.email e2e@example.invalid
git config user.name e2e
mkdir -p .vscode docs
printf '%s\n' "$2" > .vscode/settings.json
printf 'wbprobe-needle\n' > docs/needle.md
printf 'export function one() {\n  return 1;\n}\n' > f.ts
git add .
git commit -qm one
printf 'export function one() {\n  return 2;\n}\n\nexport function two() {\n  return one() + 1;\n}\n' > f.ts
git commit -qam two
whiteboard api session_create "{\"title\":\"$1\",\"open\":false,\"target\":{\"kind\":\"commits\",\"repositoryPath\":\"$HOME/wbprobe\",\"base\":\"HEAD~1\",\"head\":\"HEAD\"}}" | field sessionId
`;

export async function run(ctx) {
  // A packaged build ignores DEV_FAST_REVIEW_SSH_CONFIG, so its ssh would read the user's configuration.
  if (ctx.report.mode === "packaged")
    throw new Error("skip: remote-window-probe runs in development mode only");

  try {
    await exec("docker", ["info", "--format", "{{.ServerVersion}}"]);
  } catch (error) {
    throw new Error(
      `skip: remote-window-probe needs Docker for its SSH server (${error.message.split("\n")[0]})`,
    );
  }

  try {
    await journey(ctx);
  } finally {
    await remote("down", "--all").catch((error) =>
      console.error(`[remote-window-probe] down --all: ${error.message}`),
    );
  }
}

function check(ctx, text) {
  console.error(`[remote-window-probe] ${new Date().toISOString()} ${text}`);
  ctx.check(text);
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function journey(ctx) {
  const { page, until } = ctx;

  await remote("up", "a");
  await remote("install", "a");
  await onRemote("whiteboard remote extensions ensure --json");
  await remote("install-extension", "a", probeDir);
  await onRemote(
    `cat > "${probeHome}/probe-config.json"`,
    JSON.stringify({ otherAuthority }),
  );
  // The host's own VS Code settings, which a Source window must not read either.
  await onRemote(
    'for d in Machine User; do mkdir -p ~/.dev/whiteboard-remote/server/data/$d && cat > ~/.dev/whiteboard-remote/server/data/$d/settings.json; done',
    JSON.stringify(hostile),
  );

  const reviewId = await onRemote(
    `bash -s -- '${title}' '${JSON.stringify(hostile)}'`,
    fixture,
  );

  assert.match(reviewId, /^[0-9a-f-]{36}$/, "the remote review's id");

  const settingsFile = path.join(ctx.userData, "User/settings.json");

  check(
    ctx,
    `1. ${alias} holds a review whose checkout has a hostile .vscode/settings.json, its VS Code server has hostile Machine and User settings, and the probe (with a keybinding, a menu item, a command and a grammar) is installed`,
  );

  // 2. Add the host; it must offer language features, which Source windows need.
  const settings = await openSettings(ctx);
  const section = settings.getByRole("region", { name: "Remote hosts" });

  await section.getByLabel("SSH alias").fill(alias);
  await section.getByRole("button", { name: "Add", exact: true }).click();
  await until(
    async () => {
      const host = (await ctx.apiOk("/remote-hosts")).find(
        (h) => h.alias === alias,
      );

      return host?.state === "online" && host.languageFeatures === true;
    },
    `${alias} online with language features`,
    180000,
  );
  check(ctx, `2. Settings added ${alias}; online with language features`);

  // Adding the host wrote it into the laptop's settings; nothing may change them after.
  const settingsBefore = sha256(await readFile(settingsFile));

  // 3. Open the review, show f.ts in the Diff view, click Open file.
  await openHome(ctx);

  const row = page
    .locator("main.review-home")
    .getByRole("region", { name: "Sessions", exact: true })
    .locator("tbody tr")
    .filter({ hasText: title });

  await row.waitFor({ timeout: 60000 });
  await row.getByTitle(title, { exact: true }).click();

  const canvas = page.locator(".review-canvas-root [data-review-api]");

  await canvas
    .getByRole("heading", { name: title })
    .waitFor({ timeout: 60000 });
  await page
    .locator('[aria-label="Session views"] button[aria-label="Diff"]')
    .filter({ visible: true })
    .click();
  await until(
    async () =>
      (
        await page
          .locator(".review-path-label")
          .filter({ visible: true })
          .allInnerTexts()
      ).some((text) => text.includes("f.ts")),
    "the Diff view to show f.ts",
  );

  const opened = Date.now();

  await page
    .locator(".review-multidiff-open")
    .filter({ visible: true })
    .first()
    .click();

  const source = await sourceWindowFor(ctx, "f.ts");

  await until(
    async () => (await lines(source)).includes("return one() + 1;"),
    "f.ts's text from the host in the Source window",
    120000,
  );

  const openMs = Date.now() - opened;
  let state = await inSource(source, windowState);
  const { authority } = state;

  assert.match(authority, /^whiteboard\+[0-9a-f-]+$/, JSON.stringify(state));
  assert.equal(state.title, `${title} — Source — Whiteboard`);
  assert.equal(await source.title(), state.title);
  assert.match(
    state.folder,
    new RegExp(`^vscode-remote://${authority.replace("+", "%2B")}/`),
  );
  check(
    ctx,
    `3. Open file opened a Source window on ${authority} in ${openMs} ms, titled "${state.title}", showing the host's f.ts (${state.active.resource})`,
  );

  // 4. The probe's manifest registers nothing in the window, although the probe is there.
  assert.deepEqual(state.probe, {
    scheme: "vscode-remote",
    authority,
  });
  assert.deepEqual(state.contributions, {
    keybindings: [],
    command: false,
    menuItems: [],
    language: false,
    grammar: false,
  });
  assert.ok(
    state.grammars > 0,
    "no grammar at all in the window, so the check proves nothing",
  );
  await source.locator(".monaco-editor .view-lines").first().click();
  assert.equal(await quickInputVisible(source), false);
  // Keys are handled in order: if the chord had opened quick open with its
  // argument, the quick open that ⌘P shows next would hold that text.
  await source.keyboard.press("ControlOrMeta+Shift+Alt+KeyY");
  await source.keyboard.press("ControlOrMeta+KeyP");

  const quick = source.locator(".quick-input-widget input");

  await quick.waitFor({ state: "visible" });
  assert.equal(
    await quick.inputValue(),
    "",
    "the probe's keybinding opened quick open with its argument",
  );
  await source.keyboard.press("Escape");
  await quick.waitFor({ state: "hidden" });

  await source.keyboard.press("ControlOrMeta+Shift+KeyP");
  await quick.waitFor({ state: "visible" });
  await quick.fill(">Reload Window");
  await until(
    async () => (await quickRows(source)).some((t) => t.includes("Reload")),
    "Reload Window in the command palette",
  );
  await quick.fill(">Run the remote guard probe");

  const paletteRows = await until(async () => {
    const rows = await quickRows(source);

    // The palette has answered once it says it found nothing, or offers similar commands.
    if (rows.some((t) => /No matching commands|similar commands/.test(t)))
      return rows;
    throw new Error(JSON.stringify(rows));
  }, "the palette's answer for the probe's command");

  assert.ok(
    !paletteRows.some((t) => /remote guard probe/i.test(t)),
    `the probe's command in the palette: ${paletteRows}`,
  );
  await source.keyboard.press("Escape");
  check(
    ctx,
    `4. the probe is one of the window's extensions (on ${authority}), yet its keybinding, command, menu item, language and grammar are not registered (${state.grammars} laptop grammars are); its key chord did nothing and the palette lists Reload Window but not its command`,
  );

  // 5. Read-only and default settings, whatever the checkout and the host say.
  const typed = await typeInto(source, ctx);

  assert.ok(typed.message, "no read-only notice after typing");
  assertDefaults(state);
  check(
    ctx,
    `5. typing in f.ts changed nothing and showed "${typed.message}"; editor.fontSize ${state.config.fontSize.value} (${state.fontPx} rendered, the hostile 40 ignored), files.readonlyInclude ${JSON.stringify(state.config.readonlyInclude)}, files.readonlyExclude ${JSON.stringify(state.config.readonlyExclude)}`,
  );

  // 6. Quick open, text search and a TypeScript hover answer from the host.
  await source.keyboard.press("ControlOrMeta+KeyP");
  await quick.waitFor({ state: "visible" });
  await quick.fill("needle");
  await until(
    async () => (await quickRows(source)).some((t) => t.includes("needle.md")),
    "needle.md in quick open",
    60000,
  );
  await source.keyboard.press("Escape");

  await source.keyboard.press("ControlOrMeta+Shift+KeyF");
  await until(
    () =>
      source.evaluate(
        () => !!document.activeElement?.closest(".search-view .search-widget"),
      ),
    "focus in the search view's input",
  );
  await source.keyboard.press("ControlOrMeta+KeyA");
  await source.keyboard.type("wbprobe-needle");

  const results = await until(async () => {
    const text = await source
      .locator(".search-view")
      .innerText()
      .catch(() => "");

    return text.includes("needle.md") && text;
  }, "needle.md in the search results");

  await inSource(source, focusFile, state.active.resource);

  const point = await inSource(source, pointAt, 6, "one");

  const hover = await pointerHover(
    source,
    point,
    /function one\(\): number/,
    90000,
  );

  assert.ok(hover.ms !== null, `no hover: ${JSON.stringify(hover.seen)}`);
  check(
    ctx,
    `6. quick open found needle.md, text search found wbprobe-needle in it ("${results.replace(/\s+/g, " ").slice(0, 80)}…"), and the hover on one read "${hover.text.match(/function one\(\): number/)[0]}" after ${hover.ms} ms`,
  );

  // 7. Laptop documents in the window, then the probe runs.
  const secret = `wbprobe-secret-${randomUUID()}`;
  const fileProbe = `/tmp/wb-probe-file-${randomUUID()}.txt`;
  const orderBefore = await readFile(path.join(ctx.repo, "order.ts"), "utf8");
  const laptop = await inSource(source, openLaptopDocuments, secret);

  await inSource(source, focusFile, state.active.resource);
  await onRemote(
    `cat > "${probeHome}/source-go.json"`,
    JSON.stringify({
      secret,
      emptyFile: laptop.emptyFile,
      laptopFile: settingsFile,
      laptopFolder: ctx.repo,
      laptopRoot: ctx.root,
      fileProbe,
      authority,
      otherAuthority,
    }),
  );

  const log = await until(
    async () => {
      const text = await onRemote(
        'p=$(find ~/.dev/whiteboard-remote -name source-probe.log | head -1); [ -n "$p" ] && cat "$p" || true',
      );

      return /^done$/m.test(text) && text;
    },
    "the probe to finish in the Source window",
    180000,
  );

  console.error(`[remote-window-probe] source-probe.log:\n${log}`);

  for (const action of REFUSED)
    assert.ok(
      log.includes(`${action}: refused:`),
      `${action} was not refused:\n${log}`,
    );

  assert.doesNotMatch(log, /NOT REFUSED|crashed|UNEXPECTEDLY|SKIPPED/);
  assert.match(log, /^showInformationMessage: ALLOWED$/m);
  assert.match(
    log,
    /^search this remote's own files: 1 file\(s\), 1 text match\(es\)$/m,
    "the host's own search did not answer, so the refused searches prove nothing",
  );
  assert.match(
    log,
    /^workspace\.fs\.writeFile on this remote's checkout through the window: allowed \(own files\)$/m,
  );
  assert.ok(
    !existsSync(fileProbe),
    "the probe's file: write landed on the laptop",
  );
  assert.equal(
    await onRemote(`test -f '${fileProbe}' && echo host`),
    "host",
    "a file: write from the host is its own disk",
  );
  assert.ok(!existsSync(path.join(ctx.root, "probe-local.txt")));
  assert.equal(
    await readFile(path.join(ctx.repo, "order.ts"), "utf8"),
    orderBefore,
  );
  assert.ok(!existsSync(path.join(ctx.repo, "order-renamed.ts")));

  // Every command the host sees is the allow-list's or its own extensions'.
  const seen = JSON.parse(
    await onRemote(
      'cat "$(dirname "$(find ~/.dev/whiteboard-remote -name source-probe.log | head -1)")/source-commands.json"',
    ),
  );

  state = await inSource(source, windowState);
  console.error(
    `[remote-window-probe] commands the host sees: ${JSON.stringify(seen)}`,
  );

  const windowCommands = new Set(state.windowCommands);
  const allowed = new Set(state.allowedCommands);
  // `_typescript.x` belongs with `typescript.reloadProjects` from the manifest.
  const prefix = (id) => id.replace(/^_+/, "").split(".")[0];
  // TypeScript also registers js.projectStatus.command, which its manifest does not list.
  const own = new Set([...state.remoteCommands.map(prefix), "js"]);

  assert.deepEqual(
    seen.filter((id) => windowCommands.has(id) && !allowed.has(id)),
    [],
    "window commands the host sees",
  );
  assert.deepEqual(
    seen.filter(
      (id) =>
        !allowed.has(id) &&
        !own.has(prefix(id)) &&
        // The extension host's own argument-converter command.
        !/^__vsc[0-9a-f-]{36}$/.test(id),
    ),
    [],
    "commands the host sees that are neither allowed nor its extensions'",
  );

  const commandCount = Number(log.match(/^command count: (\d+)$/m)[1]);

  check(
    ctx,
    `7. with an untitled laptop buffer holding a secret and the laptop's empty Source side open in the window, the probe saw ${REFUSED.length} actions refused (${commandCount} commands visible to it: the allow-list and its extensions' own, none of the window's), its own search answered, showInformationMessage allowed`,
  );

  // 8. After the probe wrote .vscode/settings.json: the window is unchanged.
  state = await inSource(source, windowState);
  assertDefaults(state);
  assert.equal(state.title, `${title} — Source — Whiteboard`);

  const again = await typeInto(source, ctx);

  assert.ok(again.message, "no read-only notice after the probe's settings");

  const folder = new URL(state.folder).pathname;
  const status = await onRemote(`git -C '${folder}' status --porcelain`);

  assert.equal(
    status,
    "M .vscode/settings.json\n?? probe-own.txt",
    "the checkout changed",
  );
  assert.equal(
    await onRemote(`git -C '${folder}' diff --quiet HEAD -- f.ts && echo same`),
    "same",
  );
  await onRemote(
    `git -C '${folder}' checkout -- .vscode/settings.json && rm '${folder}/probe-own.txt'`,
  );
  check(
    ctx,
    `8. after the probe's .vscode/settings.json: same title, still read-only, editor.fontSize ${state.config.fontSize.value}; the checkout holds only the probe's own writes (git status "${status.replace("\n", "; ")}"), f.ts unchanged`,
  );

  // 9. The laptop: settings unchanged, nothing started, the guard logged its refusals.
  assert.equal(
    sha256(await readFile(settingsFile)),
    settingsBefore,
    "the laptop's settings changed",
  );
  assert.doesNotMatch(
    await readFile(settingsFile, "utf8"),
    /editor\.fontSize|wb probe/,
  );
  assert.equal(
    (
      await exec("pgrep", ["-f", "wb-probe-marker"]).catch(() => ({
        stdout: "",
      }))
    ).stdout,
    "",
    "a process for the probe's file: link",
  );

  const guard = (await windowLog(ctx)).match(
    new RegExp(
      `\\[Remote guard\\] ${authority.replace("+", "\\+")}: refused .*`,
      "g",
    ),
  );

  for (const kind of [
    "reading files outside this remote",
    "running window commands",
    "using the clipboard",
    "downloading",
    "changing settings",
    "editing documents or files",
    "searching outside this remote",
  ])
    assert.ok(
      guard?.some((line) => line.endsWith(`refused ${kind}`)),
      `no "${kind}" refusal for ${authority} in the window log:\n${guard?.join("\n")}`,
    );

  // The untitled buffer would otherwise ask to be saved.
  await inSource(source, revertAll);
  await closeSourceWindow(source);
  check(
    ctx,
    `9. the laptop's settings unchanged, no process started, ${new Set(guard).size} kinds of refusal logged for ${authority}; the Source window closed`,
  );
}

function assertDefaults(state) {
  const { fontSize } = state.config;

  assert.equal(fontSize.workspaceValue, undefined, JSON.stringify(fontSize));
  assert.equal(fontSize.workspaceFolderValue, undefined);
  assert.equal(fontSize.userRemoteValue, undefined);
  assert.equal(fontSize.value, fontSize.userValue ?? fontSize.defaultValue);
  assert.notEqual(fontSize.value, 40);
  assert.equal(state.fontPx, `${fontSize.value}px`);
  assert.deepEqual(state.config.readonlyInclude, { "**/*": true });
  assert.deepEqual(state.config.readonlyExclude, {});
  assert.ok(state.active.readonly, "f.ts is not read-only");
}

/** Types into f.ts; returns the read-only notice, after checking the text did not change. */
async function typeInto(source, ctx) {
  const before = await inSource(source, fileText);

  await source.locator(".monaco-editor .view-lines").first().click();
  await source.keyboard.type("x");

  const message = await ctx.until(
    () =>
      source.evaluate(() =>
        [...document.querySelectorAll(".monaco-editor-overlaymessage")]
          .map((e) => e.innerText.trim())
          .find(Boolean),
      ),
    "the read-only notice",
    10000,
  );

  assert.equal(await inSource(source, fileText), before, "typing changed f.ts");

  return { message };
}

async function quickInputVisible(page) {
  return page.evaluate(() => {
    const widget = document.querySelector(".quick-input-widget");

    return !!widget && widget.style.display !== "none" && !!widget.offsetParent;
  });
}

async function quickRows(page) {
  return page
    .locator(".quick-input-list .monaco-list-row")
    .allInnerTexts()
    .catch(() => []);
}

/** The window's own logs, where `[Remote guard]` lines go. */
async function windowLog(ctx) {
  const { readdir } = await import("node:fs/promises");
  const root = path.join(ctx.userData, "logs");

  const files = (await readdir(root, { recursive: true })).filter((file) =>
    file.endsWith(".log"),
  );

  return (
    await Promise.all(
      files.map((file) =>
        readFile(path.join(root, file), "utf8").catch(() => ""),
      ),
    )
  ).join("\n");
}

/**
 * Runs `fn` in the Source window with its services, reached through its
 * extension service instance: the journey needs no hook in the product.
 */
async function inSource(page, fn, ...args) {
  const cdp = await page.context().newCDPSession(page);

  try {
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    const prototype = await cdp.send("Runtime.evaluate", {
      expression:
        'import(globalThis._VSCODE_FILE_ROOT + "vs/workbench/services/extensions/electron-browser/nativeExtensionService.js").then((m) => m.NativeExtensionService.prototype)',
      awaitPromise: true,
    });

    const { objects } = await cdp.send("Runtime.queryObjects", {
      prototypeObjectId: prototype.result.objectId,
    });

    const result = await cdp.send("Runtime.callFunctionOn", {
      objectId: objects.objectId,
      functionDeclaration: `async function (args) {
        // Subclass prototypes have the prototype in their chain too.
        const service = [...this].reverse().find((s) => Object.hasOwn(s, "_instantiationService"));
        const imp = (file) => import(globalThis._VSCODE_FILE_ROOT + file);
        const get = async (file, id) => {
          const module = await imp(file);
          return service._instantiationService.invokeFunction((a) => a.get(module[id]));
        };
        const value = await (${fn.toString()})({ service, get, imp }, ...args);
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      }`,
      arguments: [{ value: args }],
      awaitPromise: true,
      returnByValue: true,
    });

    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );

    return result.result.value;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// The functions below run in the Source window.

async function windowState({ service, get, imp }) {
  const [config, keybindings, languages, editors, workspace, environment, tm] =
    await Promise.all([
      get(
        "vs/platform/configuration/common/configuration.js",
        "IConfigurationService",
      ),
      get("vs/platform/keybinding/common/keybinding.js", "IKeybindingService"),
      get("vs/editor/common/languages/language.js", "ILanguageService"),
      get(
        "vs/workbench/services/editor/common/editorService.js",
        "IEditorService",
      ),
      get("vs/platform/workspace/common/workspace.js", "IWorkspaceContextService"),
      get(
        "vs/workbench/services/environment/common/environmentService.js",
        "IWorkbenchEnvironmentService",
      ),
      get(
        "vs/workbench/services/textMate/browser/textMateTokenizationFeature.js",
        "ITextMateTokenizationService",
      ),
    ]);

  const { MenuRegistry, MenuId } = await imp(
    "vs/platform/actions/common/actions.js",
  );

  const { CommandsRegistry } = await imp(
    "vs/platform/commands/common/commands.js",
  );

  const { REMOTE_WINDOW_COMMANDS } = await imp(
    "vs/review/services/remote/guard/reviewRemoteCommandService.js",
  );

  const probe = service.extensions.find(
    (e) => e.identifier.value === "wb-test.remote-guard-probe",
  );

  const fromProbe = (item) => item.command?.id === "wbProbe.run";

  const lines = document.querySelector(
    ".editor-instance .monaco-editor .view-lines",
  );

  return {
    authority: environment.remoteAuthority,
    title: document.title,
    folder: workspace.getWorkspace().folders[0]?.uri.toString(),
    probe: probe && {
      scheme: probe.extensionLocation.scheme,
      authority: probe.extensionLocation.authority,
    },
    contributions: {
      keybindings: keybindings
        .getKeybindings()
        .flatMap((k) =>
          k.commandArgs === "wbprobekeybinding" ||
          k.extensionId === "wb-test.remote-guard-probe"
            ? [k.command]
            : [],
        ),
      command: !!MenuRegistry.getCommand("wbProbe.run"),
      menuItems: [MenuId.EditorContext, MenuId.CommandPalette].flatMap((id) =>
        MenuRegistry.getMenuItems(id).flatMap((item) =>
          fromProbe(item) ? [item.command.id] : [],
        ),
      ),
      language: languages.isRegisteredLanguageId("wbprobelang"),
      grammar: (tm._grammarDefinitions ?? []).some(
        (g) => g.scopeName === "source.wbprobe",
      ),
    },
    grammars: (tm._grammarDefinitions ?? []).length,
    windowCommands: [...CommandsRegistry.getCommands().keys()],
    allowedCommands: [...REMOTE_WINDOW_COMMANDS.keys()],
    // Commands the host's extensions declare in their manifests.
    remoteCommands: service.extensions.flatMap((e) =>
      e.extensionLocation.authority === environment.remoteAuthority
        ? (e.contributes?.commands ?? []).map((c) => c.command)
        : [],
    ),
    config: {
      fontSize: (({
        value,
        defaultValue,
        userValue,
        userRemoteValue,
        workspaceValue,
        workspaceFolderValue,
      }) => ({
        value,
        defaultValue,
        userValue,
        userRemoteValue,
        workspaceValue,
        workspaceFolderValue,
      }))(config.inspect("editor.fontSize")),
      readonlyInclude: config.getValue("files.readonlyInclude"),
      readonlyExclude: config.getValue("files.readonlyExclude"),
    },
    fontPx: lines && getComputedStyle(lines).fontSize,
    active: {
      resource: editors.activeEditor?.resource?.toString(),
      readonly: !!editors.activeEditor?.isReadonly(),
    },
  };
}

async function revertAll({ get }) {
  const editors = await get(
    "vs/workbench/services/editor/common/editorService.js",
    "IEditorService",
  );

  return editors.revertAll({ includeUntitled: true });
}

async function fileText({ get }) {
  const models = await get(
    "vs/editor/common/services/model.js",
    "IModelService",
  );

  return models
    .getModels()
    .find((m) => m.uri.scheme === "vscode-remote" && m.uri.path.endsWith("/f.ts"))
    ?.getValue();
}

async function focusFile({ get, imp }, resource) {
  const editors = await get(
    "vs/workbench/services/editor/common/editorService.js",
    "IEditorService",
  );

  const { URI } = await imp("vs/base/common/uri.js");

  await editors.openEditor({
    resource: URI.parse(resource),
    options: { pinned: true },
  });

  return true;
}

async function pointAt({ get }, line, word) {
  const editor = (
    await get("vs/editor/browser/services/codeEditorService.js", "ICodeEditorService")
  ).getActiveCodeEditor();

  const position = {
    lineNumber: line,
    column: editor.getModel().getLineContent(line).indexOf(word) + 2,
  };

  editor.revealLineInCenter(line);

  let at = editor.getScrolledVisiblePosition(position);

  for (let frame = 0; !at && frame < 120; frame++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    at = editor.getScrolledVisiblePosition(position);
  }

  if (!at) throw new Error(`line ${line} never rendered`);

  const rect = editor.getDomNode().getBoundingClientRect();

  return {
    x: Math.round(rect.left + at.left),
    y: Math.round(rect.top + at.top + at.height / 2),
  };
}

/** An untitled buffer holding `secret`, and the laptop's empty Source side as a remote diff opens it. */
async function openLaptopDocuments({ get, imp }, secret) {
  const [editors, files, environment] = await Promise.all([
    get("vs/workbench/services/editor/common/editorService.js", "IEditorService"),
    get("vs/platform/files/common/files.js", "IFileService"),
    get("vs/platform/environment/common/environment.js", "IEnvironmentService"),
  ]);

  const { VSBuffer } = await imp("vs/base/common/buffer.js");
  const { joinPath } = await imp("vs/base/common/resources.js");
  const empty = joinPath(environment.cacheHome, "source-empty", "empty");

  await files.writeFile(empty, VSBuffer.fromString(""));
  await editors.openEditor({
    resource: empty.with({ scheme: "vscode-userdata" }),
    options: { pinned: true },
  });
  await editors.openEditor({
    resource: undefined,
    // Twice: a laptop hit would set limitHit at maxResults 1.
    contents: `wbprobe ${secret}\n${secret}\n`,
    options: { pinned: true },
  });

  return { emptyFile: empty.path };
}
