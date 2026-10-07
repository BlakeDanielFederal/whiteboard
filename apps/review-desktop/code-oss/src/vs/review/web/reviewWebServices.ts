/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// Review's diff services on upstream's standalone editor services, for a browser
// with no workbench. Only the workbench services those diff classes touch are
// provided here; each stub throws on any member it does not implement.

import "../../editor/standalone/browser/standaloneServices.js";
import "../common/reviewConfiguration.js";

import { Event } from "../../base/common/event.js";
import { Disposable } from "../../base/common/lifecycle.js";
import type { URI } from "../../base/common/uri.js";
import { StandaloneServices } from "../../editor/standalone/browser/standaloneServices.js";
import type { StandaloneThemeService } from "../../editor/standalone/browser/standaloneThemeService.js";
import { IStandaloneThemeService, type IStandaloneThemeData } from "../../editor/standalone/common/standaloneTheme.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import { IModelService } from "../../editor/common/services/model.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import type { IInstantiationService, ServiceIdentifier } from "../../platform/instantiation/common/instantiation.js";
import { ServiceCollection } from "../../platform/instantiation/common/serviceCollection.js";
import { IMultiDiffSourceResolverService } from "../../workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js";
import { IDecorationsService } from "../../workbench/services/decorations/common/decorations.js";
import { IEditorGroupsService } from "../../workbench/services/editor/common/editorGroupsService.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import { INotebookDocumentService } from "../../workbench/services/notebook/common/notebookDocumentService.js";
import { ITextFileService } from "../../workbench/services/textfile/common/textfiles.js";
import { REVIEW_API_SOURCE_SCHEME } from "../common/reviewSourceView.js";
import { reviewApiSourceContentProvider, type ReviewSourceRead } from "../services/reviewApiSourceContent.js";
import { ReviewWebTextMate, type ReviewWebTokenTheme } from "./reviewWebTextMate.js";
import { ReviewWebTextModelService } from "./reviewWebTextModelService.js";

/** Desktop's Whiteboard Light and Dark colors, resolved by the bundle build. */
declare const __REVIEW_WEB_THEMES__: Record<ReviewWebTheme, { editor: IStandaloneThemeData; tokens: ReviewWebTokenTheme }>;

export type ReviewWebTheme = "light" | "dark";

export function reviewWebThemeId(theme: ReviewWebTheme): string {
	return `review-${theme}`;
}

export interface ReviewWebServicesOptions {
	read: ReviewSourceRead;
	theme: ReviewWebTheme;
	/** Opens a review source file, for the diff's "open file" action. */
	openFile(resource: URI): void;
}

/** A service that implements `members` and fails loudly on anything else. */
function browserStub<T>(id: ServiceIdentifier<T>, members: object): T {
	return new Proxy(members, {
		get(target, property) {
			if (property in target) return Reflect.get(target, property);
			if (typeof property === "symbol" || property === "then" || property === "_serviceBrand") return undefined;
			throw new Error(`${String(id)}.${property} is not available in the browser host.`);
		},
	}) as T;
}

export interface ReviewWebServices {
	/** The scope Review's diff classes are created in. */
	instantiation: IInstantiationService;
	setTheme(theme: ReviewWebTheme): void;
	dispose(): void;
}

/** Initializes the standalone services once and returns a scope for Review's diff classes. */
export function createReviewWebServices(options: ReviewWebServicesOptions): ReviewWebServices {
	const standalone = StandaloneServices.initialize({});
	// Standalone editors install the theme's stylesheet when they are created;
	// Review's diff classes build plain editor widgets, so install it here, as
	// upstream's standalone editors do, through the concrete service.
	const themes = StandaloneServices.get(IStandaloneThemeService);
	for (const theme of ["light", "dark"] as const) themes.defineTheme(reviewWebThemeId(theme), __REVIEW_WEB_THEMES__[theme].editor);
	(themes as StandaloneThemeService).registerEditorContainer(document.body);
	// Languages register before any review source model is created. Its token
	// stylesheet comes after the editor theme's, so the TextMate colors win.
	const textMate = new ReviewWebTextMate(standalone);
	const setTheme = (theme: ReviewWebTheme) => {
		themes.setTheme(reviewWebThemeId(theme));
		// The editor theme resets the token color map; reapply the TextMate one.
		textMate.setTheme(__REVIEW_WEB_THEMES__[theme].tokens);
	};
	setTheme(options.theme);
	const textModels = standalone.createInstance(ReviewWebTextModelService);
	textModels.registerTextModelContentProvider(
		REVIEW_API_SOURCE_SCHEME,
		reviewApiSourceContentProvider(StandaloneServices.get(IModelService), StandaloneServices.get(ILanguageService), options.read),
	);

	const instantiation = standalone.createChild(new ServiceCollection(
		[ITextModelService, textModels],
		[IEditorService, browserStub(IEditorService, {
			openEditor: async (input: { resource?: URI }) => {
				if (input.resource) options.openFile(input.resource);
				return undefined;
			},
		})],
		[IEditorGroupsService, browserStub(IEditorGroupsService, { mainPart: { activeGroup: undefined } })],
		// Review sources are read-only: nothing is ever dirty, untitled or saved.
		[ITextFileService, browserStub(ITextFileService, {
			files: { onDidChangeDirty: Event.None },
			untitled: { get: () => undefined, onDidChangeLabel: Event.None },
			isDirty: () => false,
		})],
		[IMultiDiffSourceResolverService, browserStub(IMultiDiffSourceResolverService, { registerResolver: () => Disposable.None })],
		[IDecorationsService, browserStub(IDecorationsService, { onDidChangeDecorations: Event.None, getDecoration: () => undefined })],
		[INotebookDocumentService, browserStub(INotebookDocumentService, { getNotebook: () => undefined })],
	));

	return { instantiation, setTheme, dispose: () => textMate.dispose() };
}
