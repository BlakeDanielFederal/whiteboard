// Test only. Installed on a wb-test remote by `remote.mjs install-extension`.
// On activation it attempts, in turn, each action the guard (Stage 2, Task 7)
// must block on the laptop, then one action it must allow, and appends one line
// per action to a log file: "<action>: refused: <message>" or
// "<action>: ALLOWED". Task 9's journey reuses it. The log goes to
// $WB_PROBE_LOG_DIR/probe.log when set, else to the extension's global-storage
// folder on the remote (printed on the first line).
//
// In a Source window (a workspace file, which the review window's host never
// has) it waits for the journey's source-go.json, then runs the same actions
// and the Source window's own into source-probe.log.
const fs = require("node:fs");

const path = require("node:path");

const vscode = require("vscode");

async function refuses(name, attempt, log) {
  try {
    const note = await attempt();
    log(`${name}: NOT REFUSED${note ? ` (${note})` : ""}`);
  } catch (error) {
    log(`${name}: refused: ${message(error)}`);
  }
}

async function observe(name, attempt, log) {
  try {
    log(`${name}: ${(await attempt()) || "ok"}`);
  } catch (error) {
    log(`${name}: threw: ${message(error)}`);
  }
}

function message(error) {
  return String((error && error.message) || error).replace(/\s+/g, " ");
}

function windowUri(scheme, fsPath) {
  return vscode.Uri.from({ scheme, path: fsPath });
}

async function ownEditor() {
  for (let i = 0; i < 30 && !vscode.window.visibleTextEditors.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 500));

  return vscode.window.visibleTextEditors[0];
}

function readConfig(context) {
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(context.extensionPath, "probe-config.json"),
        "utf8",
      ),
    );
  } catch {
    return {};
  }
}

async function run(context, logName = "probe.log", extra) {
  const dir = process.env.WB_PROBE_LOG_DIR || context.globalStorageUri.fsPath;
  const logFile = path.join(dir, logName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(logFile, `log: ${logFile}\n`);
  const log = (line) => fs.appendFileSync(logFile, `${line}\n`);

  const localHosts = windowUri("vscode-local", "/etc/hosts");
  const fileHosts = windowUri("file", "/etc/hosts");
  const config = readConfig(context);

  const otherAuthority =
    process.env.WB_PROBE_OTHER_AUTHORITY || config.otherAuthority;

  // 1. Read the laptop's /etc/hosts. From a remote extension, vscode-local: is
  // the laptop; file: is the remote's own disk (its transformer keeps it here),
  // so reading file: is not a laptop breach and is expected to succeed.
  await refuses(
    "read vscode-local:/etc/hosts",
    async () => {
      const bytes = await vscode.workspace.fs.readFile(localHosts);

      return `${bytes.length} bytes`;
    },
    log,
  );
  await observe(
    "read file:///etc/hosts (the remote's own disk, not the laptop)",
    async () => {
      const bytes = await vscode.workspace.fs.readFile(fileHosts);

      return `${bytes.length} bytes from the remote`;
    },
    log,
  );

  // 2. Read a file on the other remote's authority.
  if (otherAuthority) {
    await refuses(
      "read the other remote's /etc/hosts",
      async () => {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.parse(`vscode-remote://${otherAuthority}/etc/hosts`),
        );

        return `${bytes.length} bytes`;
      },
      log,
    );
  } else {
    log(
      "read the other remote's /etc/hosts: SKIPPED (no WB_PROBE_OTHER_AUTHORITY)",
    );
  }

  // 3. Open a file: link with the operating system.
  await refuses(
    "openExternal file:///tmp/wb-probe-marker.command",
    async () => {
      const opened = await vscode.env.openExternal(
        windowUri("file", "/tmp/wb-probe-marker.command"),
      );

      return `returned ${opened}`;
    },
    log,
  );

  // 4. Run a window command that opens a folder on the laptop.
  await refuses(
    "executeCommand vscode.openFolder",
    () => vscode.commands.executeCommand("vscode.openFolder", fileHosts),
    log,
  );

  // 5. Read and write the laptop clipboard.
  await refuses(
    "clipboard.readText",
    async () => {
      const text = await vscode.env.clipboard.readText();

      return `${text.length} chars`;
    },
    log,
  );
  await refuses(
    "clipboard.writeText",
    () => vscode.env.clipboard.writeText("wb-probe-was-here"),
    log,
  );

  // 6. Write a laptop setting.
  await refuses(
    "update a global setting",
    () =>
      vscode.workspace
        .getConfiguration()
        .update("editor.fontSize", 41, vscode.ConfigurationTarget.Global),
    log,
  );

  // 7. Download a URL onto the laptop (the spike's path: _workbench.downloadResource).
  await refuses(
    "download a URL",
    () =>
      vscode.commands.executeCommand(
        "_workbench.downloadResource",
        vscode.Uri.parse("https://example.com/wb-probe"),
      ),
    log,
  );

  // 8. Open a webview panel. createWebviewPanel is fire-and-forget: the window
  // guard refuses it (see the window log), but the extension gets no error.
  await observe(
    "open a webview panel",
    () => {
      const panel = vscode.window.createWebviewPanel(
        "wbProbe",
        "wb probe",
        vscode.ViewColumn.One,
        {},
      );

      panel.dispose();

      return "SENT (fire-and-forget; the window guard refuses it)";
    },
    log,
  );

  // 9. Apply a workspace edit on a laptop file. The guard makes applyEdit
  // return false (no edit applied); true would be a breach.
  await refuses(
    "applyEdit on the laptop",
    async () => {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(localHosts, new vscode.Position(0, 0), "wb-probe\n");
      const applied = await vscode.workspace.applyEdit(edit);

      if (applied) return "applyEdit returned true";
      throw new Error("applyEdit returned false");
    },
    log,
  );

  // 10. Register a command id the window already has (vscode.openFolder is a
  // window command, absent from this host's own registry). registerCommand is
  // fire-and-forget: it registers in this host's registry, and the window guard
  // refuses replacing its command (see the window log). No error reaches the
  // extension, so this is recorded, not asserted.
  await observe(
    "registerCommand vscode.openFolder (a window command)",
    () => {
      const registration = vscode.commands.registerCommand(
        "vscode.openFolder",
        () => {},
      );

      registration.dispose();

      return "SENT (fire-and-forget; the window guard refuses the replacement)";
    },
    log,
  );

  // 11-14. Window UI the remote writes into, which the laptop user may click.
  // Each is fire-and-forget; the live check inspects the window: the status
  // bar item's command must be the host's relay (which refuses the laptop
  // command), and the texts must have lost their command: links.
  const openFolder = "command:vscode.openFolder?%5B%22file%3A%2F%2F%2F%22%5D";

  await observe(
    "status bar item with a laptop command",
    () => {
      const item = vscode.window.createStatusBarItem("wbProbe.item");

      item.text = "wb probe";
      item.tooltip = new vscode.MarkdownString(
        `wb probe [open](${openFolder}) [web](https://ok.example) [hosts](file:///etc/hosts)`,
      );
      item.command = {
        command: "vscode.openFolder",
        title: "Open",
        arguments: [vscode.Uri.file("/")],
      };
      item.show();
      context.subscriptions.push(item);

      return "SENT (window check)";
    },
    log,
  );
  await observe(
    "notification with a command: link",
    () => {
      vscode.window.showWarningMessage(
        `wb probe notification [open](${openFolder})`,
      );
      vscode.window.showWarningMessage(
        `wb probe gt [open](command:vscode.open?%5B%22file%3A%2F%2F%2Fetc%2Fhosts%22%5D#>x) [t](${openFolder} "t"x")`,
      );

      return "SENT (window check)";
    },
    log,
  );
  await observe(
    "window progress with a command link",
    () => {
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: `wb probe progress [open](${openFolder})`,
        },
        () => new Promise((resolve) => setTimeout(resolve, 60_000)),
      );

      return "SENT (window check)";
    },
    log,
  );
  await observe(
    "diagnostic with a command: code target",
    () => {
      const diagnostics =
        vscode.languages.createDiagnosticCollection("wbProbe");

      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        "wb probe diagnostic",
      );

      diagnostic.code = {
        value: "WBPROBE",
        target: vscode.Uri.parse(openFolder),
      };
      diagnostics.set(vscode.Uri.file("/tmp/wb-test-proj/a.ts"), [diagnostic]);
      context.subscriptions.push(diagnostics);

      return "SENT (window check)";
    },
    log,
  );
  await observe(
    "quick input with a command link",
    () => {
      const box = vscode.window.createInputBox();

      box.title = "wb probe";
      box.prompt = `wb probe prompt [open](${openFolder})`;
      box.validationMessage = `wb probe validation [open](${openFolder})`;
      box.show();
      context.subscriptions.push(box);

      return "SENT (window check)";
    },
    log,
  );

  // 16-19. An editor on this remote's own file, opened by the check (the
  // probe opens none): a decoration whose hover holds a trusted command: link
  // and whose icons and CSS point elsewhere, then the edits and options a
  // read-only review refuses. The live check inspects the window's editor.
  const editor = await ownEditor();

  if (editor) {
    await observe(
      "decoration with a trusted command: hover, a laptop icon and CSS",
      () => {
        const hover = new vscode.MarkdownString(
          `wb probe hover [open](${openFolder})`,
        );

        hover.isTrusted = true;

        const type = vscode.window.createTextEditorDecorationType({
          gutterIconPath: windowUri("vscode-local", "/etc/hosts"),
          backgroundColor:
            "red; background-image: url(https://example.com/wb-probe.png)",
          after: {
            contentText: " wb probe after",
            contentIconPath: vscode.Uri.parse(
              "https://example.com/wb-probe.png",
            ),
          },
        });

        editor.setDecorations(type, [
          { range: new vscode.Range(0, 0, 0, 1), hoverMessage: hover },
        ]);
        context.subscriptions.push(type);

        return "SENT (window check)";
      },
      log,
    );
    await refuses(
      "edit this remote's editor",
      async () =>
        `edit returned ${await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "wb-probe"))}`,
      log,
    );
    await refuses(
      "insertSnippet in this remote's editor",
      async () =>
        `returned ${await editor.insertSnippet(new vscode.SnippetString("wb-probe"))}`,
      log,
    );
    await observe(
      "set this remote's editor options",
      () => {
        editor.options = { tabSize: 7 };

        return "SENT (window check)";
      },
      log,
    );
  } else {
    log(
      "decorations and edits in this remote's editor: SKIPPED (no editor on this remote's files)",
    );
  }

  await observe(
    "language status item with a command",
    () => {
      const item = vscode.languages.createLanguageStatusItem(
        "wbProbe.status",
        "*",
      );

      item.text = "wb probe status";
      item.command = {
        command: "vscode.openFolder",
        title: "Open",
        arguments: [vscode.Uri.file("/")],
      };
      context.subscriptions.push(item);

      return "SENT (the window guard log)";
    },
    log,
  );

  if (extra) await extra({ log, dir, localHosts });

  try {
    vscode.window.showInformationMessage("wb probe: guard check ran");
    log("showInformationMessage: ALLOWED");
  } catch (error) {
    log(`showInformationMessage: UNEXPECTEDLY REFUSED: ${message(error)}`);
  }

  log("done");

  return logFile;
}

// Window commands a Source window's host must not see.
const WINDOW_COMMANDS = [
  "workbench.action.files.openFile",
  "vscode.openFolder",
  "workbench.action.reloadWindow",
  "workbench.action.quickOpen",
  "_workbench.downloadResource",
  "editor.action.clipboardCopyAction",
  "workbench.action.openSettingsJson",
];

/** Waits for the journey's source-go.json: it opens laptop documents in the window first. */
async function sourceGo(context) {
  const file = path.join(context.extensionPath, "source-go.json");

  for (let i = 0; i < 1200; i++) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error("no source-go.json within 10 minutes");
}

/** Breach when it found something; refused when it threw or found nothing. */
async function finds(name, attempt, log) {
  await refuses(
    name,
    async () => {
      const found = await attempt();

      if (found) return found;
      throw new Error("nothing returned");
    },
    log,
  );
}

/** The stage 2 actions, then the Source window's own, into source-probe.log. */
async function sourceRun(context) {
  const go = await sourceGo(context);
  const folder = vscode.workspace.workspaceFolders[0].uri;
  const laptopFolder = windowUri("vscode-local", go.laptopFolder);

  await run(context, "source-probe.log", async ({ log, dir }) => {
    log(
      `window: remoteName ${vscode.env.remoteName}, folder ${folder.toString()}, workspace file ${vscode.workspace.workspaceFile}`,
    );

    // Laptop files and documents.
    await refuses(
      "read the laptop's settings.json through vscode-local",
      async () =>
        `${(await vscode.workspace.fs.readFile(windowUri("vscode-local", go.laptopFile))).length} bytes`,
      log,
    );
    await refuses(
      "openTextDocument on the laptop's settings.json",
      async () =>
        `${(await vscode.workspace.openTextDocument(windowUri("vscode-local", go.laptopFile))).getText().length} chars`,
      log,
    );
    await refuses(
      "openTextDocument on the laptop's empty Source side",
      async () =>
        `${(await vscode.workspace.openTextDocument(windowUri("vscode-userdata", go.emptyFile))).uri}`,
      log,
    );
    await finds(
      "see the laptop's open documents",
      async () => {
        const seen = vscode.workspace.textDocuments.filter(
          (d) => d.uri.scheme !== "file" || d.getText().includes(go.secret),
        );

        log(
          `open documents: ${vscode.workspace.textDocuments.map((d) => d.uri.toString()).join(", ")}`,
        );

        return seen.length && seen.map((d) => d.uri.toString()).join(", ");
      },
      log,
    );

    // Commands: the allow-list and the host's own, never the window's.
    const commands = await vscode.commands.getCommands();

    fs.writeFileSync(
      path.join(dir, "source-commands.json"),
      JSON.stringify(commands),
    );
    log(`command count: ${commands.length}`);
    await finds(
      "see the window's commands",
      async () =>
        WINDOW_COMMANDS.filter((id) => commands.includes(id)).join(", "),
      log,
    );
    await refuses(
      "executeCommand workbench.action.quickOpen with arguments",
      () =>
        vscode.commands.executeCommand(
          "workbench.action.quickOpen",
          "wbprobecommand",
        ),
      log,
    );

    // Search: own files answer; laptop folders, another host and the
    // laptop's open buffers do not.
    await observe(
      "search this remote's own files",
      async () => {
        const own = await vscode.workspace.findFiles("**/needle.md");
        const ownText = [];

        await vscode.workspace.findTextInFiles(
          { pattern: "wbprobe-needle" },
          {},
          (result) => ownText.push(result),
        );

        return `${own.length} file(s), ${ownText.length} text match(es)`;
      },
      log,
    );
    await finds(
      "findFiles in a laptop folder",
      async () =>
        (
          await vscode.workspace.findFiles(
            new vscode.RelativePattern(laptopFolder, "**/*"),
          )
        ).length,
      log,
    );
    await finds(
      "findTextInFiles in a laptop folder",
      async () => {
        const results = [];

        await vscode.workspace.findTextInFiles(
          { pattern: "status" },
          { include: new vscode.RelativePattern(laptopFolder, "**/*") },
          (result) => results.push(result),
        );

        return results.length;
      },
      log,
    );
    await finds(
      "findFiles on another host",
      async () =>
        (
          await vscode.workspace.findFiles(
            new vscode.RelativePattern(
              vscode.Uri.parse(`vscode-remote://${go.otherAuthority}/`),
              "**/*",
            ),
          )
        ).length,
      log,
    );
    await finds(
      "text search learns a laptop buffer (results or limitHit)",
      async () => {
        const results = [];

        const complete = await vscode.workspace.findTextInFiles(
          { pattern: go.secret },
          { maxResults: 1 },
          (result) => results.push(result),
        );

        return (
          (results.length || complete.limitHit) &&
          `${results.length} result(s), limitHit ${complete.limitHit}`
        );
      },
      log,
    );

    // Writes: the window's edits are refused; the host's own disk is its own.
    await refuses(
      "applyEdit on this remote's checkout",
      async () => {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(
          vscode.Uri.joinPath(folder, "f.ts"),
          new vscode.Position(0, 0),
          "wb-probe\n",
        );

        if (await vscode.workspace.applyEdit(edit))
          return "applyEdit returned true";
        throw new Error("applyEdit returned false");
      },
      log,
    );
    const bytes = Buffer.from("wb-probe");

    const own = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: go.authority,
      path: `${folder.path}/probe-own.txt`,
    });

    await observe(
      "workspace.fs.writeFile on this remote's checkout through the window",
      async () => {
        await vscode.workspace.fs.writeFile(own, bytes);

        return "allowed (own files)";
      },
      log,
    );
    await observe(
      "workspace.fs.writeFile on a file: path (this host's own disk here)",
      async () => {
        await vscode.workspace.fs.writeFile(
          windowUri("file", go.fileProbe),
          bytes,
        );

        return "written";
      },
      log,
    );

    const laptopFile = windowUri("vscode-local", `${go.laptopFolder}/order.ts`);

    for (const [name, target] of [
      [
        "a laptop file through vscode-local",
        windowUri("vscode-local", `${go.laptopRoot}/probe-local.txt`),
      ],
      [
        "another host's file",
        vscode.Uri.parse(`vscode-remote://${go.otherAuthority}/tmp/probe.txt`),
      ],
      [
        "the laptop's empty Source side",
        windowUri("vscode-userdata", go.emptyFile),
      ],
    ])
      await refuses(
        `workspace.fs.writeFile on ${name}`,
        async () => {
          await vscode.workspace.fs.writeFile(target, bytes);

          return "written";
        },
        log,
      );

    await refuses(
      "workspace.fs.delete on a laptop file",
      async () => {
        await vscode.workspace.fs.delete(laptopFile);

        return "deleted";
      },
      log,
    );
    await refuses(
      "workspace.fs.rename on a laptop file",
      async () => {
        await vscode.workspace.fs.rename(
          laptopFile,
          windowUri("vscode-local", `${go.laptopFolder}/order-renamed.ts`),
        );

        return "renamed";
      },
      log,
    );

    // Settings from the remote change nothing, here or in the window.
    const settings = path.join(folder.fsPath, ".vscode", "settings.json");

    fs.mkdirSync(path.dirname(settings), { recursive: true });

    // The guard passes on changes only for the host's own keys, so a change
    // to editor.fontSize must never arrive: a timeout is the expected outcome.
    const changed = new Promise((resolve) => {
      const listener = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("editor.fontSize")) {
          listener.dispose();
          resolve("changed");
        }
      });

      setTimeout(() => {
        listener.dispose();
        resolve("no change event within 10 s");
      }, 10000);
    });

    fs.writeFileSync(
      settings,
      JSON.stringify({
        "editor.fontSize": 41,
        "files.readonlyInclude": { "**/*": false },
        "files.readonlyExclude": { "**/*": true },
        "window.title": "wb probe runtime title",
      }),
    );
    log("write .vscode/settings.json: written");
    log(`editor.fontSize change event: ${await changed}`);
    await finds(
      "read back editor.fontSize from .vscode/settings.json",
      async () => {
        const config = vscode.workspace.getConfiguration("editor");
        const inspected = config.inspect("fontSize");

        log(`editor.fontSize read back: ${config.get("fontSize")}`);

        return (
          ([40, 41].includes(config.get("fontSize")) ||
            inspected?.globalValue !== undefined ||
            inspected?.workspaceValue !== undefined ||
            inspected?.workspaceFolderValue !== undefined) &&
          JSON.stringify(inspected)
        );
      },
      log,
    );
  });
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("wbProbe.run", () => run(context)),
  );

  const source = vscode.workspace.workspaceFile !== undefined;
  const logName = source ? "source-probe.log" : "probe.log";

  (source ? sourceRun(context) : run(context)).catch((error) => {
    try {
      const dir =
        process.env.WB_PROBE_LOG_DIR || context.globalStorageUri.fsPath;

      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, logName),
        `probe crashed: ${String((error && error.stack) || error)}\n`,
      );
    } catch {}
  });
}

module.exports = { activate, deactivate() {} };
