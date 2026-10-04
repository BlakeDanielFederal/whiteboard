import assert from "node:assert/strict";
import test from "node:test";
import { Event } from "../../../base/common/event.js";
import { URI } from "../../../base/common/uri.js";
import { MenuId, MenuRegistry } from "../../../platform/actions/common/actions.js";
import { Extensions, type IConfigurationRegistry } from "../../../platform/configuration/common/configurationRegistry.js";
import { ExtensionIdentifier, type IExtensionDescription } from "../../../platform/extensions/common/extensions.js";
import { Registry } from "../../../platform/registry/common/platform.js";
import "../../../workbench/api/common/configurationExtensionPoint.js";
import "../../../workbench/services/actions/common/menusExtensionPoint.js";
import { AbstractExtensionService } from "../../../workbench/services/extensions/common/abstractExtensionService.js";
import { ExtensionsRegistry, type IExtensionPointUser } from "../../../workbench/services/extensions/common/extensionsRegistry.js";
import { WorkbenchLanguageService } from "../../../workbench/services/language/common/languageService.js";
import { grammarsExtPoint } from "../../../workbench/services/textMate/common/TMGrammars.js";
import { registersContributions } from "./reviewRemoteWindowScope.js";

const manifest = {
	commands: [{ command: "probe.run", title: "Run Probe" }],
	menus: { "editor/context": [{ command: "probe.run" }] },
	keybindings: [{ command: "vscode.openFolder", key: "ctrl+alt+p", args: { forceNewWindow: true } }],
	configurationDefaults: { "probe.setting": 7 },
	grammars: [{ language: "probe", scopeName: "source.probe", path: "./probe.tmLanguage.json" }],
	languages: [{ id: "probe", extensions: [".probe"], configuration: "./language-configuration.json" }],
};

function extension(id: string, location: URI) {
	return { identifier: new ExtensionIdentifier(id), extensionLocation: location, contributes: manifest, isBuiltin: false, isUnderDevelopment: false } as unknown as IExtensionDescription;
}

test("a Source window registers no manifest contribution of its Whiteboard host's extensions", async () => {
	const keybindingsExtPoint = ExtensionsRegistry.getExtensionPoints().find((point) => point.name === "keybindings")
		?? ExtensionsRegistry.registerExtensionPoint({ extensionPoint: "keybindings", jsonSchema: {} });
	const users = (point: { setHandler(handler: (users: readonly IExtensionPointUser<unknown>[]) => void): unknown }) => {
		let seen: string[] = [];
		point.setHandler((all) => { seen = all.map((user) => user.description.identifier.value); });
		return () => seen;
	};
	const keybindings = users(keybindingsExtPoint);
	const grammars = users(grammarsExtPoint);
	const languages = new WorkbenchLanguageService(
		{ whenInstalledExtensionsRegistered: () => new Promise(() => { }), activateByEvent: async () => { } } as never,
		{ getValue: () => ({}), onDidChangeConfiguration: Event.None } as never,
		{ verbose: false, isExtensionDevelopment: false, isBuilt: true } as never,
		{ trace() { }, info() { }, warn() { }, error() { } } as never,
	);
	const errors: string[] = [];
	let registered: IExtensionDescription[] = [];
	const window = Object.assign(Object.create(AbstractExtensionService.prototype), {
		_registry: { getAllExtensionDescriptions: () => registered, getExtensionDescription: () => undefined },
		_extensionStatus: new Map(),
		_logService: { info() { }, warn: (message: string) => errors.push(message), error: (message: string) => errors.push(message) },
		_environmentService: { isBuilt: false },
		_registersContributions: registersContributions,
	});
	const handle = async (extensions: IExtensionDescription[]) => {
		registered = extensions;
		window._doHandleExtensionPoints(extensions, false);
		await Promise.resolve();
	};
	const defaults = () => Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurationDefaultsOverrides().get("probe.setting");
	const menu = () => MenuRegistry.getMenuItems(MenuId.EditorContext).some((item) => "command" in item && item.command.id === "probe.run");

	const remote = extension("remote.probe", URI.parse("vscode-remote://whiteboard+abc/srv/extensions/probe"));
	await handle([remote]);
	assert.deepEqual(keybindings(), []);
	assert.deepEqual(grammars(), []);
	assert.equal(MenuRegistry.getCommand("probe.run"), undefined);
	assert.equal(menu(), false);
	assert.equal(defaults(), undefined);
	assert.equal(languages.isRegisteredLanguageId("probe"), false);
	assert.deepEqual(languages.getConfigurationFiles("probe"), []);

	const laptop = extension("laptop.probe", URI.file("/Users/me/.vscode/extensions/probe"));
	await handle([remote, laptop]);
	assert.deepEqual(keybindings(), ["laptop.probe"]);
	assert.deepEqual(grammars(), ["laptop.probe"]);
	assert.equal(menu(), true);
	assert.deepEqual(defaults(), { value: 7, source: { id: "laptop.probe", displayName: undefined } });
	assert.deepEqual(languages.getConfigurationFiles("probe").map(String), ["file:///Users/me/.vscode/extensions/probe/language-configuration.json"]);
	assert.deepEqual(errors, []);
	languages.dispose();
});

test("only extensions on a Whiteboard host lose their contributions", () => {
	const at = (location: string) => registersContributions(extension("x.y", URI.parse(location)));
	assert.equal(at("vscode-remote://whiteboard+abc/srv/extensions/x"), false);
	assert.equal(at("file:///Users/me/.vscode/extensions/x"), true);
	assert.equal(at("vscode-remote://ssh-remote+x/srv/extensions/x"), true);
	assert.equal(at("vscode-remote://Whiteboard+ABC/srv/extensions/x"), true);
});
