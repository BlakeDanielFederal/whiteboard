import assert from "node:assert/strict";
import test from "node:test";
import { Event } from "../../../base/common/event.js";
import { URI } from "../../../base/common/uri.js";
import { IBulkEditService } from "../../../editor/browser/services/bulkEditService.js";
import { ILanguageFeaturesService } from "../../../editor/common/services/languageFeatures.js";
import { IModelService } from "../../../editor/common/services/model.js";
import { ITextModelService } from "../../../editor/common/services/resolverService.js";
import { IClipboardService } from "../../../platform/clipboard/common/clipboardService.js";
import { CommandsRegistry, ICommandService } from "../../../platform/commands/common/commands.js";
import { IConfigurationService } from "../../../platform/configuration/common/configuration.js";
import { IDownloadService } from "../../../platform/download/common/download.js";
import { IEnvironmentService } from "../../../platform/environment/common/environment.js";
import { IExtensionHostDebugService } from "../../../platform/debug/common/extensionHostDebug.js";
import { ExtensionIdentifier, type IExtensionDescription } from "../../../platform/extensions/common/extensions.js";
import { IFileService } from "../../../platform/files/common/files.js";
import type { IInstantiationService, ServiceIdentifier } from "../../../platform/instantiation/common/instantiation.js";
import { InstantiationService } from "../../../platform/instantiation/common/instantiationService.js";
import { ServiceCollection } from "../../../platform/instantiation/common/serviceCollection.js";
import { ILabelService } from "../../../platform/label/common/label.js";
import { ILanguagePackService } from "../../../platform/languagePacks/common/languagePacks.js";
import { ILoggerService, ILogService } from "../../../platform/log/common/log.js";
import { IMarkerService } from "../../../platform/markers/common/markers.js";
import { INotificationService } from "../../../platform/notification/common/notification.js";
import { IOpenerService } from "../../../platform/opener/common/opener.js";
import { IProductService } from "../../../platform/product/common/productService.js";
import { IProgressService } from "../../../platform/progress/common/progress.js";
import { IRemoteAuthorityResolverService } from "../../../platform/remote/common/remoteAuthorityResolver.js";
import type { IRemoteExtensionsScannerService } from "../../../platform/remote/common/remoteExtensionsScanner.js";
import { IRemoteSocketFactoryService } from "../../../platform/remote/common/remoteSocketFactoryService.js";
import { IRequestService } from "../../../platform/request/common/request.js";
import { ISecretStorageService } from "../../../platform/secrets/common/secrets.js";
import { ISignService } from "../../../platform/sign/common/sign.js";
import { IStorageService } from "../../../platform/storage/common/storage.js";
import { ITelemetryService } from "../../../platform/telemetry/common/telemetry.js";
import { IUriIdentityService } from "../../../platform/uriIdentity/common/uriIdentity.js";
import { IWorkspaceContextService } from "../../../platform/workspace/common/workspace.js";
import { IWorkspaceTrustRequestService } from "../../../platform/workspace/common/workspaceTrust.js";
import { IExtensionStatusBarItemService } from "../../../workbench/api/browser/statusBarExtensionPoint.js";
import { IExtensionsWorkbenchService } from "../../../workbench/contrib/extensions/common/extensions.js";
import { IWebviewViewService } from "../../../workbench/contrib/webviewView/browser/webviewViewService.js";
import { IWorkbenchAssignmentService } from "../../../workbench/services/assignment/common/assignmentService.js";
import { IDecorationsService } from "../../../workbench/services/decorations/common/decorations.js";
import { IEditorGroupsService } from "../../../workbench/services/editor/common/editorGroupsService.js";
import { IEditorService } from "../../../workbench/services/editor/common/editorService.js";
import { IWorkbenchEnvironmentService } from "../../../workbench/services/environment/common/environmentService.js";
import { IWorkbenchExtensionEnablementService } from "../../../workbench/services/extensionManagement/common/extensionManagement.js";
import { LocalProcessRunningLocation, RemoteRunningLocation } from "../../../workbench/services/extensions/common/extensionRunningLocation.js";
import { ExtensionHostExtensions, IExtensionService, type IExtensionHost, type IInternalExtensionService } from "../../../workbench/services/extensions/common/extensions.js";
import type { IExtensionDescriptionDelta } from "../../../workbench/services/extensions/common/extensionHostProtocol.js";
import { RemoteExtensionHost } from "../../../workbench/services/extensions/common/remoteExtensionHost.js";
import { ILanguageStatusService } from "../../../workbench/services/languageStatus/common/languageStatusService.js";
import { ISearchService, QueryType, SearchProviderType, type ISearchResultProvider } from "../../../workbench/services/search/common/search.js";
import { IDefaultLogLevelsService } from "../../../workbench/services/log/common/defaultLogLevels.js";
import { ITextFileService } from "../../../workbench/services/textfile/common/textfiles.js";
import { IWorkingCopyFileService } from "../../../workbench/services/workingCopy/common/workingCopyFileService.js";
import { REMOTE_WINDOW_COMMANDS } from "./guard/reviewRemoteCommandService.js";
import { IWebviewWorkbenchServiceId } from "./guard/reviewRemoteWebviewWorkbenchService.js";
import { reviewRemoteExtensionsScanner, ReviewRemoteWindowExtensionHosts, reviewRemoteWindowScope } from "./reviewRemoteWindowScope.js";

const W = "whiteboard+abc";
const own = URI.parse(`vscode-remote://${W}/home/dev/proj/f.ts`);
const refused = /^Error: Not available for an extension on abc: /;

function extension(id: string, location: URI) {
	return { identifier: new ExtensionIdentifier(id), extensionLocation: location } as IExtensionDescription;
}

/** A Source window's services, recording what reaches them. */
function sourceWindow() {
	const reached: string[] = [];
	const warnings: string[] = [];
	const record = (name: string) => async (...args: unknown[]) => { reached.push(`${name} ${args[0]}`); return {}; };
	const services = new ServiceCollection();
	const fake = <T>(id: ServiceIdentifier<T>, value: object = {}) => services.set(id, value as T);
	fake(ILogService, { warn: (message: string) => warnings.push(message), trace() { }, info() { }, error() { } });
	fake(IFileService, { readFile: record("readFile"), writeFile: record("writeFile"), listCapabilities: () => [], onDidChangeFileSystemProviderRegistrations: Event.None, onDidChangeFileSystemProviderCapabilities: Event.None });
	fake(ILoggerService, { createLogger: record("createLogger"), onDidChangeLogLevel: Event.None });
	fake(IConfigurationService, { onDidChangeConfiguration: Event.None, getValue: () => undefined, updateValue: record("updateValue") });
	fake(IExtensionService, {
		extensions: [
			extension("laptop.ext", URI.file("/Users/me/.vscode/extensions/laptop.ext")),
			extension("vscode.typescript-language-features", URI.parse(`vscode-remote://${W}/srv/extensions/typescript`)),
			extension("other.host", URI.parse("vscode-remote://whiteboard+other/srv/extensions/x")),
		],
	});
	fake(ITextFileService, { files: {}, untitled: {} });
	fake(ITelemetryService, { publicLog2: (name: string) => reached.push(`telemetry ${name}`) });
	fake(IWorkbenchEnvironmentService, {
		get isExtensionDevelopment() { reached.push("window environment"); return false; },
		extensionDevelopmentLocationURI: undefined,
		debugExtensionHost: { port: null, break: false },
	});
	fake(ISearchService, {
		registerSearchResultProvider: (scheme: string) => { reached.push(`search provider ${scheme}`); return { dispose() { } }; },
		fileSearch: record("fileSearch"),
	});
	fake(ILanguageFeaturesService, new Proxy({}, { get: () => ({ register: () => ({ dispose() { } }) }) }));
	fake(IRemoteAuthorityResolverService, { resolveAuthority: (name: string) => { reached.push(`resolve ${name}`); return new Promise(() => { }); } });
	for (const id of [
		ILanguageFeaturesService, IWorkspaceContextService, IExtensionStatusBarItemService, INotificationService, IProgressService, IExtensionsWorkbenchService,
		IWorkbenchExtensionEnablementService, IModelService, IMarkerService, ITextModelService, ITextFileService, IWorkingCopyFileService, IEditorGroupsService,
		IEditorService, IOpenerService, IStorageService, ISecretStorageService, IWebviewWorkbenchServiceId, IWebviewViewService, ILabelService, IDecorationsService,
		IWorkspaceTrustRequestService, IRequestService, ILanguagePackService, IEnvironmentService, IBulkEditService, ILanguageStatusService,
		IRemoteSocketFactoryService, IExtensionHostDebugService, IProductService, ISignService, IDefaultLogLevelsService, IWorkbenchAssignmentService, IUriIdentityService,
	] as ServiceIdentifier<unknown>[]) {
		if (!services.has(id)) fake(id);
	}
	return { window: new InstantiationService(services, true) as IInstantiationService, reached, warnings };
}

test("a Source window's scope keeps a remote's extensions to that window's own host", async () => {
	const { window, reached, warnings } = sourceWindow();
	const scope = reviewRemoteWindowScope({ authority: W, services: window, activate: async () => { } });
	const get = <T>(id: ServiceIdentifier<T>) => scope.invokeFunction((accessor) => accessor.get(id));
	const files = get(IFileService);

	for (const elsewhere of [URI.file("/etc/hosts"), URI.parse("vscode-local:/etc/hosts"), URI.parse("vscode-remote://whiteboard+other/home/dev/proj/f.ts")]) {
		await assert.rejects(files.readFile(elsewhere), refused, elsewhere.toString());
		assert.throws(() => files.writeFile(elsewhere, undefined as never), refused, elsewhere.toString());
	}
	await files.readFile(own);
	await files.writeFile(own, undefined as never);

	const registrations = ["workbench.action.files.openFile", "vscode.openFolder", "_executeHoverProvider"].map((id) => CommandsRegistry.registerCommand(id, () => reached.push(`ran ${id}`)));
	const commands = get(ICommandService) as ICommandService & { ids(): string[] };
	assert.deepEqual(commands.ids(), ["_executeHoverProvider"]);
	assert.ok(commands.ids().every((id) => REMOTE_WINDOW_COMMANDS.has(id)));
	await assert.rejects(commands.executeCommand("workbench.action.files.openFile"), refused);
	await assert.rejects(commands.executeCommand("vscode.openFolder", URI.file("/")), refused);
	for (const registration of registrations) registration.dispose();

	await assert.rejects(get(IClipboardService).readText(), refused);
	await assert.rejects(get(IClipboardService).writeText("secret"), refused);
	await assert.rejects(get(IDownloadService).download(URI.parse("https://example.com/"), URI.file("/tmp/x"), "extension"), refused);
	await assert.rejects(get(IConfigurationService).updateValue("window.title", "x"), refused);
	assert.deepEqual(get(IExtensionService).extensions.map((e) => e.identifier.value), ["vscode.typescript-language-features"]);

	assert.deepEqual(reached, [`readFile ${own}`, `writeFile ${own}`]);
	for (const kind of ["reading files outside this remote", "changing files outside this remote", "running window commands", "using the clipboard", "downloading", "changing settings"]) {
		assert.equal(warnings.filter((warning) => warning === `[Remote guard] ${W}: refused ${kind}`).length, 1, kind);
	}
});

test("a Source window's search is the window's, so its host's providers reach it, and the host searches only its own files", async () => {
	const { window, reached, warnings } = sourceWindow();
	const scope = reviewRemoteWindowScope({ authority: W, services: window, activate: async () => { } });
	const search = scope.invokeFunction((accessor) => accessor.get(ISearchService));
	search.registerSearchResultProvider("vscode-remote", SearchProviderType.text, {} as ISearchResultProvider);
	search.registerSearchResultProvider("file", SearchProviderType.text, {} as ISearchResultProvider);
	assert.deepEqual(reached, ["search provider vscode-remote"]);
	await assert.rejects(search.fileSearch({ type: QueryType.File, folderQueries: [{ folder: URI.file("/Users/me") }] }), refused);
	assert.deepEqual(reached, ["search provider vscode-remote"]);
	assert.equal(warnings.filter((warning) => warning === `[Remote guard] ${W}: refused searching outside this remote`).length, 1);
});

test("only a whiteboard+ window's remote extension host is rebuilt, with its manager, inside the guard", () => {
	const { window, reached } = sourceWindow();
	const hosts = new ReviewRemoteWindowExtensionHosts(window);
	const internal = {} as IInternalExtensionService;
	const stock = (authority: string) => {
		const host = window.createInstance(RemoteExtensionHost, new RemoteRunningLocation(), { remoteAuthority: authority, getInitData: () => new Promise(() => { }) });
		let disposed = false;
		const dispose = host.dispose.bind(host);
		host.dispose = () => { disposed = true; dispose(); };
		return { host, disposed: () => disposed };
	};

	const local = { runningLocation: new LocalProcessRunningLocation(0), remoteAuthority: null } as unknown as IExtensionHost;
	assert.equal(hosts.create(local, [], internal), undefined);
	const ssh = stock("ssh-remote+x");
	assert.equal(hosts.create(ssh.host, [], internal), undefined, "another remote gets upstream's factory");
	assert.equal(ssh.disposed(), false);

	for (const authority of ["Whiteboard+ABC", "whiteboard+a/b"]) {
		const other = stock(authority);
		assert.equal(hosts.create(other.host, [], internal), undefined, `${authority} is not ours, and gets upstream's peers too`);
		assert.equal(other.disposed(), false);
	}

	const ours = stock(W);
	reached.length = 0;
	const manager = hosts.create(ours.host, ["onStartupFinished"], internal);
	assert.ok(manager);
	assert.equal(ours.disposed(), true, "upstream's host is replaced, never started");
	assert.deepEqual(reached, [`resolve ${W}`], "the replacement starts with upstream's data, and neither it nor its manager reads the window's environment or telemetry");
	hosts.dispose();
});

test("a Whiteboard host's extension host is told only of that host's own extensions, never the laptop's", async () => {
	const { window } = sourceWindow();
	const hosts = new ReviewRemoteWindowExtensionHosts(window);
	const laptop = extension("laptop.ext", URI.file("/Users/me/.vscode/extensions/laptop.ext"));
	const other = extension("other.host", URI.parse("vscode-remote://whiteboard+other/srv/extensions/x"));
	const typescript = extension("vscode.typescript-language-features", URI.parse(`vscode-remote://${W}/srv/extensions/typescript`));
	const json = extension("vscode.json-language-features", URI.parse(`vscode-remote://${W}/srv/extensions/json`));
	const all = [laptop, other, typescript];
	const ids = (extensions: readonly IExtensionDescription[]) => extensions.map((e) => e.identifier);
	const stock = window.createInstance(RemoteExtensionHost, new RemoteRunningLocation(), {
		remoteAuthority: W,
		getInitData: async () => ({ extensions: new ExtensionHostExtensions(3, all, ids(all)) }) as never,
	});
	const manager = hosts.create(stock, [], {} as IInternalExtensionService);
	assert.ok(manager);
	const raw = (hosts as unknown as { manager: { _extensionHost: RemoteExtensionHost; deltaExtensions(delta: IExtensionDescriptionDelta): Promise<void> } }).manager;

	const init = await raw._extensionHost._initDataProvider.getInitData();
	assert.deepEqual([init.extensions.versionId, ids(init.extensions.allExtensions).map((id) => id.value), init.extensions.myExtensions.map((id) => id.value)], [3, ["vscode.typescript-language-features"], ["vscode.typescript-language-features"]]);

	raw._extensionHost.extensions = init.extensions;
	const sent: IExtensionDescriptionDelta[] = [];
	raw.deltaExtensions = async (delta) => { sent.push(delta); };
	const added = [laptop, other, json];
	await manager.deltaExtensions({
		versionId: 4,
		toRemove: ids([laptop, typescript]),
		toAdd: added,
		addActivationEvents: { "laptop.ext": ["*"], "other.host": ["*"], "vscode.json-language-features": ["onLanguage:json"] },
		myToRemove: ids([laptop, typescript]),
		myToAdd: ids(added),
	});
	const values = (list: readonly ExtensionIdentifier[]) => list.map((id) => id.value);
	assert.deepEqual(sent.map((delta) => ({ ...delta, toRemove: values(delta.toRemove), toAdd: delta.toAdd, myToRemove: values(delta.myToRemove), myToAdd: values(delta.myToAdd) })), [{
		versionId: 4,
		toRemove: ["vscode.typescript-language-features"],
		toAdd: [json],
		addActivationEvents: { "vscode.json-language-features": ["onLanguage:json"] },
		myToRemove: ["vscode.typescript-language-features"],
		myToAdd: ["vscode.json-language-features"],
	}]);
	hosts.dispose();
});

test("a Source window takes from its host's scan only the extensions on its own authority", async () => {
	const scanned = [
		extension("own.ext", URI.parse(`vscode-remote://${W}/home/dev/.vscode-server/extensions/own`)),
		extension("laptop.ext", URI.file("/Users/dev/.vscode/extensions/laptop")),
		extension("upper.ext", URI.parse("vscode-remote://WHITEBOARD+ABC/home/dev/.vscode-server/extensions/upper")),
	];
	const warnings: string[] = [];
	const logService = { warn: (message: string) => warnings.push(message) } as unknown as ILogService;
	const base = { scanExtensions: async () => scanned } as unknown as IRemoteExtensionsScannerService;

	const scanner = reviewRemoteExtensionsScanner(base, W, logService);
	assert.deepEqual((await scanner.scanExtensions()).map((e) => e.identifier.value), ["own.ext"]);
	await scanner.scanExtensions();
	assert.deepEqual(warnings, [`[Remote guard] ${W}: refused extensions the host reports outside its own authority`]);

	assert.equal(reviewRemoteExtensionsScanner(base, "ssh-remote+box", logService), base);
	assert.equal(reviewRemoteExtensionsScanner(base, undefined, logService), base);
});
