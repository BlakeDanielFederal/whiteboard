/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from "../../../../base/common/cancellation.js";
import { combinedDisposable, Disposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import type { ResourceSet } from "../../../../base/common/map.js";
import { Schemas } from "../../../../base/common/network.js";
import { IModelService } from "../../../../editor/common/services/model.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { ITelemetryService } from "../../../../platform/telemetry/common/telemetry.js";
import { IUriIdentityService } from "../../../../platform/uriIdentity/common/uriIdentity.js";
import { IEditorService } from "../../../../workbench/services/editor/common/editorService.js";
import { IExtensionService } from "../../../../workbench/services/extensions/common/extensions.js";
import {
	isFileMatch,
	type IAITextQuery,
	type IFileQuery,
	type ISearchComplete,
	type ISearchProgressItem,
	type ISearchQuery,
	type ISearchResultProvider,
	type ISearchService,
	type ITextQuery,
	type SearchProviderType,
} from "../../../../workbench/services/search/common/search.js";
import { SearchService } from "../../../../workbench/services/search/common/searchService.js";
import { IReviewRemoteRefusals, type ReviewRemoteRefusals } from "./reviewRemoteGuard.js";

const NONE: ISearchComplete = { results: [], messages: [], limitHit: false };

/** A host's provider as the window sees it: only the host's own files, in untrusted messages. */
function ownProvider(remote: ISearchResultProvider, refusals: ReviewRemoteRefusals): ISearchResultProvider {
	const narrowed = <Q extends ISearchQuery>(query: Q): Q => ({
		...query,
		folderQueries: query.folderQueries.filter((folder) => refusals.owns(folder.folder)),
		extraFileResources: query.extraFileResources?.filter((resource) => refusals.owns(resource)),
	});
	const answered = (complete: ISearchComplete): ISearchComplete => ({
		...complete,
		results: complete.results.filter((match) => refusals.owns(match.resource)),
		messages: complete.messages.map((message) => ({ ...message, trusted: false })),
	});
	return {
		getAIName: () => remote.getAIName(),
		clearCache: (cacheKey) => remote.clearCache(cacheKey),
		fileSearch: async (query, token) => {
			const own = narrowed(query);
			return own.folderQueries.length ? answered(await remote.fileSearch(own, token)) : NONE;
		},
		textSearch: async (query, onProgress, token) => {
			const own = narrowed(query);
			const progress = onProgress && ((item: ISearchProgressItem) => { if (!isFileMatch(item) || refusals.owns(item.resource)) onProgress(item); });
			return own.folderQueries.length ? answered(await remote.textSearch(own, progress, token)) : NONE;
		},
	};
}

/**
 * A Source window host's search, over its own files, providers and open models
 * only. Its `vscode-remote` providers also serve the window's searches.
 */
export class ReviewRemoteSearchService extends SearchService {
	constructor(
		private readonly windowSearch: ISearchService,
		@IReviewRemoteRefusals private readonly refusals: ReviewRemoteRefusals,
		@IModelService modelService: IModelService,
		@IEditorService editorService: IEditorService,
		@ITelemetryService telemetryService: ITelemetryService,
		@ILogService logService: ILogService,
		@IExtensionService extensionService: IExtensionService,
		@IFileService fileService: IFileService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
	) {
		super(modelService, editorService, telemetryService, logService, extensionService, fileService, uriIdentityService);
	}

	override registerSearchResultProvider(scheme: string, type: SearchProviderType, provider: ISearchResultProvider): IDisposable {
		if (scheme === Schemas.vscodeRemote) {
			return combinedDisposable(super.registerSearchResultProvider(scheme, type, provider), this.windowSearch.registerSearchResultProvider(scheme, type, ownProvider(provider, this.refusals)));
		}
		// Every host registers one for its own settings files.
		if (scheme !== Schemas.vscodeUserData) this.refusals.refuse("search providers for other schemes");
		return Disposable.None;
	}

	private ownOnly(query: ISearchQuery): void {
		const resources = [...query.folderQueries.map((folder) => folder.folder), ...(query.extraFileResources ?? [])];
		if (!resources.every((resource) => this.refusals.owns(resource))) throw this.refusals.refuse("searching outside this remote");
	}

	override async fileSearch(query: IFileQuery, token?: CancellationToken): Promise<ISearchComplete> {
		this.ownOnly(query);
		return super.fileSearch(query, token);
	}

	override async aiTextSearch(query: IAITextQuery, token?: CancellationToken, onProgress?: (item: ISearchProgressItem) => void): Promise<ISearchComplete> {
		this.ownOnly(query);
		return super.aiTextSearch(query, token, onProgress);
	}

	override textSearchSplitSyncAsync(query: ITextQuery, token?: CancellationToken, onProgress?: (item: ISearchProgressItem) => void, notebookFilesToIgnore?: ResourceSet, asyncNotebookFilesToIgnore?: Promise<ResourceSet>) {
		this.ownOnly(query);
		return super.textSearchSplitSyncAsync(query, token, onProgress, notebookFilesToIgnore, asyncNotebookFilesToIgnore);
	}
}
