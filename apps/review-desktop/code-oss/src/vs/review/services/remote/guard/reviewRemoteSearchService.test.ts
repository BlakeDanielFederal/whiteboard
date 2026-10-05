import assert from "node:assert/strict";
import test from "node:test";
import { extUri } from "../../../../base/common/resources.js";
import { URI } from "../../../../base/common/uri.js";
import { Range } from "../../../../editor/common/core/range.js";
import type { ITextModel } from "../../../../editor/common/model.js";
import type { IModelService } from "../../../../editor/common/services/model.js";
import type { IFileService } from "../../../../platform/files/common/files.js";
import type { ILogService } from "../../../../platform/log/common/log.js";
import type { ITelemetryService } from "../../../../platform/telemetry/common/telemetry.js";
import type { IUriIdentityService } from "../../../../platform/uriIdentity/common/uriIdentity.js";
import type { IEditorService } from "../../../../workbench/services/editor/common/editorService.js";
import type { IExtensionService } from "../../../../workbench/services/extensions/common/extensions.js";
import { QueryType, SearchProviderType, TextSearchCompleteMessageType, type IFileMatch, type IFileQuery, type ISearchComplete, type ISearchProgressItem, type ISearchQuery, type ISearchResultProvider, type ITextQuery } from "../../../../workbench/services/search/common/search.js";
import { SearchService } from "../../../../workbench/services/search/common/searchService.js";
import { reviewRemoteModelService } from "../reviewRemoteScope.js";
import { ReviewRemoteRefusals } from "./reviewRemoteGuard.js";
import { ReviewRemoteSearchService } from "./reviewRemoteSearchService.js";

const A = "whiteboard+aaaa-1111";
const ownFolder = URI.parse(`vscode-remote://${A}/home/dev/proj`);
const ownFile = URI.parse(`vscode-remote://${A}/home/dev/proj/a.ts`);
const laptopFile = URI.file("/Users/me/secret.txt");
const otherFile = URI.parse("vscode-remote://whiteboard+bbbb-2222/home/dev/proj/a.ts");
const refused = /^Error: Not available for an extension on wb-test-a: searching outside this remote\.$/;

function buffer(uri: URI, text: string) {
	const lines = text.split("\n");
	return {
		uri,
		getLanguageId: () => "plaintext",
		getLineCount: () => lines.length,
		getLineContent: (line: number) => lines[line - 1],
		findMatches: (pattern: string, _scope: unknown, _regex: unknown, _case: unknown, _words: unknown, _captures: unknown, limit: number) =>
			lines.flatMap((line, index) => (line.includes(pattern) ? [{ range: new Range(index + 1, line.indexOf(pattern) + 1, index + 1, line.indexOf(pattern) + 1 + pattern.length), matches: null }] : [])).slice(0, limit),
	} as unknown as ITextModel;
}

function searchWindow(buffers: ITextModel[] = []) {
	const warnings: string[] = [];
	const models = { getModels: () => buffers, onModelAdded: () => ({ dispose() { } }), onModelRemoved: () => ({ dispose() { } }), onModelLanguageChanged: () => ({ dispose() { } }) } as unknown as IModelService;
	const editors = { editors: buffers.map((model) => ({ resource: model.uri })) } as unknown as IEditorService;
	const telemetry = { publicLog2() { } } as unknown as ITelemetryService;
	const log = { trace() { }, debug() { }, warn() { } } as unknown as ILogService;
	const extensions = { activateByEvent: async () => { }, whenInstalledExtensionsRegistered: async () => true } as unknown as IExtensionService;
	const files = { exists: async () => true, hasProvider: () => true } as unknown as IFileService;
	const uris = { extUri } as unknown as IUriIdentityService;
	const window = new SearchService(models, editors, telemetry, log, extensions, files, uris);
	const refusals = new ReviewRemoteRefusals(A, () => "wb-test-a", { warn: (message: string) => warnings.push(message) } as unknown as ILogService);
	const host = new ReviewRemoteSearchService(window, refusals, reviewRemoteModelService(models, A), editors, telemetry, log, extensions, files, uris);
	return { window, host, warnings };
}

function provider(name: string, asked: string[], matches: IFileMatch[] = [ownFile, otherFile, laptopFile].map((resource) => ({ resource }))): ISearchResultProvider {
	const answer = (query: ISearchQuery, onProgress?: (item: ISearchProgressItem) => void): ISearchComplete => {
		asked.push(`${name} ${[...query.folderQueries.map((folder) => folder.folder), ...(query.extraFileResources ?? [])].join(" ")}`);
		for (const match of matches) onProgress?.(match);
		return { results: matches, limitHit: false, messages: [{ text: "[run](command:workbench.action.openSettings)", type: TextSearchCompleteMessageType.Information, trusted: true }] };
	};
	return {
		getAIName: async () => undefined,
		clearCache: async () => { },
		fileSearch: async (query) => answer(query),
		textSearch: async (query, onProgress) => answer(query, onProgress),
	};
}

const textQuery = (folders: URI[], extraFileResources?: URI[], maxResults?: number): ITextQuery => ({ type: QueryType.Text, contentPattern: { pattern: "secret" }, folderQueries: folders.map((folder) => ({ folder })), extraFileResources, maxResults });
const fileQuery = (folders: URI[], extraFileResources?: URI[]): IFileQuery => ({ type: QueryType.File, folderQueries: folders.map((folder) => ({ folder })), extraFileResources });

test("a host's search providers serve the window's text and file searches, of the host's own files only", async () => {
	const { window, host, warnings } = searchWindow();
	const asked: string[] = [];
	host.registerSearchResultProvider("vscode-remote", SearchProviderType.text, provider("remote text", asked));
	host.registerSearchResultProvider("vscode-remote", SearchProviderType.file, provider("remote file", asked));
	host.registerSearchResultProvider("vscode-userdata", SearchProviderType.text, provider("remote on settings", asked));
	assert.deepEqual(warnings, []);
	host.registerSearchResultProvider("file", SearchProviderType.file, provider("remote on file", asked));
	assert.deepEqual(warnings, [`[Remote guard] ${A}: refused search providers for other schemes`]);
	assert.equal(window.schemeHasFileSearchProvider("vscode-remote"), true);
	assert.equal(window.schemeHasFileSearchProvider("file"), false);

	const progress: string[] = [];
	const text = await window.textSearch(textQuery([ownFolder, URI.parse("vscode-remote://whiteboard+bbbb-2222/home/dev/proj")], [laptopFile]), undefined, (item) => progress.push(String((item as IFileMatch).resource)));
	assert.deepEqual(text.results.map((match) => String(match.resource)), [String(ownFile)]);
	assert.deepEqual(progress, [String(ownFile)]);
	assert.deepEqual(text.messages.map((message) => message.trusted), [false]);

	const files = await window.fileSearch(fileQuery([ownFolder]));
	assert.deepEqual(files.results.map((match) => String(match.resource)), [String(ownFile)]);

	assert.deepEqual(asked, [`remote text ${ownFolder}`, `remote file ${ownFolder}`]);
});

test("a host searches its own files only, never the laptop's", async () => {
	const { window, host, warnings } = searchWindow();
	const asked: string[] = [];
	window.registerSearchResultProvider("file", SearchProviderType.file, provider("laptop file", asked));
	window.registerSearchResultProvider("file", SearchProviderType.text, provider("laptop text", asked));
	host.registerSearchResultProvider("vscode-remote", SearchProviderType.file, provider("remote file", asked, [{ resource: ownFile }]));

	await assert.rejects(host.fileSearch(fileQuery([ownFolder, URI.file("/Users/me")])), refused);
	await assert.rejects(host.fileSearch(fileQuery([URI.parse("vscode-remote://whiteboard+bbbb-2222/home")])), refused);
	await assert.rejects(host.textSearch(textQuery([ownFolder], [laptopFile])), refused);
	assert.throws(() => host.textSearchSplitSyncAsync(textQuery([URI.file("/Users/me")])), refused);

	const own = await host.fileSearch(fileQuery([ownFolder]));
	assert.deepEqual(own.results.map((match) => String(match.resource)), [String(ownFile)]);
	assert.deepEqual(asked, [`remote file ${ownFolder}`]);
	assert.deepEqual(warnings, [`[Remote guard] ${A}: refused searching outside this remote`]);
});

test("a host's text search learns nothing of the laptop's open buffers, not even that they hit the limit", async () => {
	const { host } = searchWindow([buffer(laptopFile, "secret=a\nsecret=b"), buffer(URI.parse("untitled:Untitled-1"), "secret=c\nsecret=d")]);
	const asked: string[] = [];
	host.registerSearchResultProvider("vscode-remote", SearchProviderType.text, provider("remote text", asked, []));

	const progress: unknown[] = [];
	const found = await host.textSearch(textQuery([ownFolder], undefined, 1), undefined, (item) => progress.push(item));
	assert.equal(found.limitHit, false);
	assert.deepEqual(found.results, []);
	assert.deepEqual(progress, []);
	assert.deepEqual(found.messages.map((message) => message.text), ["[run](command:workbench.action.openSettings)"]);
	assert.deepEqual(asked, [`remote text ${ownFolder}`]);
});
