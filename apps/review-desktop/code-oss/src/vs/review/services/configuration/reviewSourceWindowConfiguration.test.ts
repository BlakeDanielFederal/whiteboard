import assert from "node:assert/strict";
import test from "node:test";
import { Emitter } from "../../../base/common/event.js";
import { URI } from "../../../base/common/uri.js";
import type { IConfigurationChangeEvent, IConfigurationModel, IConfigurationService } from "../../../platform/configuration/common/configuration.js";
import { Configuration } from "../../../platform/configuration/common/configurationModels.js";
import { NullLogService } from "../../../platform/log/common/log.js";
import { Workspace, WorkspaceFolder, type IWorkspaceContextService } from "../../../platform/workspace/common/workspace.js";
import { reviewSourceWindowDefaults } from "../../common/reviewConfigurationDefaults.js";
import { reviewSourceWindowConfiguration } from "./reviewSourceWindowConfiguration.js";

const log = new NullLogService();
const root = URI.file("/checkout");
const file = URI.file("/checkout/src/a.ts");

function model(contents: Record<string, unknown>): IConfigurationModel {
	const keys: string[] = [];
	const walk = (value: Record<string, unknown>, prefix: string) => {
		for (const [key, child] of Object.entries(value)) {
			const path = prefix ? `${prefix}.${key}` : key;
			if (["files", "window", "editor"].includes(path) && child && typeof child === "object") walk(child as Record<string, unknown>, path);
			else keys.push(path);
		}
	};
	walk(contents, "");
	return { contents, keys, overrides: [] };
}

function window(remote: boolean) {
	const [include, value] = Object.entries(reviewSourceWindowDefaults["files.readonlyInclude"])[0];
	const empty = model({});
	const data = {
		defaults: model({ files: { readonlyInclude: { [include]: value }, readonlyExclude: {} }, window: { title: "${rootName}" }, editor: { tabSize: 4, fontSize: 12 } }),
		policy: empty,
		application: empty,
		userLocal: model({ editor: { fontSize: 14 } }),
		userRemote: remote ? model({ files: { readonlyExclude: { "**/*": true } }, editor: { fontSize: 40 } }) : empty,
		workspace: model({ files: { readonlyInclude: { [include]: false }, readonlyExclude: { "**/*": true } }, window: { title: "x" }, editor: { tabSize: 2 } }),
		folders: [[root, { contents: { files: { readonlyExclude: { "src/**": true } }, editor: { tabSize: 8, fontSize: 30 } }, keys: ["files", "editor.tabSize", "editor.fontSize"], overrides: [] }]] as [URI, IConfigurationModel][],
	};
	const workspace = new Workspace("w", [new WorkspaceFolder({ uri: root, name: "repo", index: 0 })], false, URI.file("/reviews/navigator/workspaces/worktree/repo.code-workspace"), () => false);
	const configuration = Configuration.parse(data, log);
	const changed = new Emitter<IConfigurationChangeEvent>();
	const base = {
		getConfigurationData: () => configuration.toData(),
		getValue: (section?: unknown, overrides?: unknown) => configuration.getValue(typeof section === "string" ? section : undefined, (typeof section === "string" ? overrides : section) as object ?? {}, workspace),
		inspect: (key: string, overrides = {}) => configuration.inspect(key, overrides, workspace),
		getWorkspace: () => workspace,
		onDidChangeConfiguration: changed.event,
	} as unknown as IConfigurationService & IWorkspaceContextService;
	return reviewSourceWindowConfiguration(base, log, remote);
}

test("a Source window's workspace file and folders cannot lower read-only, and its title is the fork's", () => {
	for (const remote of [false, true]) {
		const { service, setTitle } = window(remote);
		assert.deepEqual(service.getValue("files.readonlyInclude", { resource: file }), { "**/*": true });
		assert.deepEqual(service.getValue("files.readonlyExclude", { resource: file }), {});
		assert.deepEqual(service.getValue<{ files: object }>({ resource: file }).files, { readonlyInclude: { "**/*": true }, readonlyExclude: {} });
		assert.equal(service.inspect("files.readonlyExclude", { resource: file }).workspaceFolderValue, undefined);
		assert.equal(service.getValue("window.title"), remote ? "${rootName}" : "x");

		const events: IConfigurationChangeEvent[] = [];
		service.onDidChangeConfiguration((e) => events.push(e));
		setTitle({ side: "live", title: "Fix the parser" });
		assert.equal(service.getValue("window.title"), "Fix the parser — Live source — Whiteboard");
		assert.equal(events.length, 1);
		assert.ok(events[0].affectsConfiguration("window.title"));
		setTitle({ side: "base", title: "Fix the parser" });
		assert.equal(service.getValue<{ window: { title: string } }>().window.title, "Fix the parser — Base source — Whiteboard");
		assert.equal(service.inspect("window.title").value, "Fix the parser — Base source — Whiteboard");
	}
});

test("a whiteboard+ Source window reads no workspace or folder setting, a local one still does", () => {
	const local = window(false).service;
	assert.equal(local.getValue("editor.tabSize", { resource: file }), 8);
	assert.equal(local.getValue("editor.tabSize"), 2);

	const remote = window(true).service;
	assert.equal(remote.getValue("editor.tabSize", { resource: file }), 4);
	assert.equal(remote.getValue("editor.fontSize", { resource: file }), 14);
	assert.deepEqual(remote.getValue<{ editor: object }>({ resource: file }).editor, { tabSize: 4, fontSize: 14 });
	const inspected = remote.inspect("editor.tabSize", { resource: file });
	assert.equal(inspected.workspaceValue, undefined);
	assert.equal(inspected.workspaceFolderValue, undefined);
	assert.equal(remote.inspect("editor.fontSize", { resource: file }).userRemoteValue, undefined);
	assert.equal(remote.inspect("files.readonlyExclude", { resource: file }).userRemoteValue, undefined);
	const data = remote.getConfigurationData()!;
	assert.deepEqual(data.workspace.keys, []);
	assert.deepEqual(data.folders, []);
	assert.deepEqual(data.userRemote.keys, []);
	assert.equal(data.userLocal.contents.editor && (data.userLocal.contents.editor as { fontSize: number }).fontSize, 14);
});
