/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// The browser diff library: Desktop's review diff services, booted on the
// standalone editor services, behind the canvas bridge's factory interfaces.
// Upstream pairs the standalone services with the same editor contributions.

import "../../editor/editor.all.js";

import type { IMonacoEnvironment } from "../../base/browser/browser.js";
import { Emitter } from "../../base/common/event.js";
import { DisposableStore, type IDisposable } from "../../base/common/lifecycle.js";
import { ICodeEditorService } from "../../editor/browser/services/codeEditorService.js";
import type { URI } from "../../base/common/uri.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { REVIEW_STRUCTURAL_DIFF_SETTING } from "../common/reviewConfigurationDefaults.js";
import type { ReviewDiffLayout, ReviewDiffViewFactory, ReviewInlineEditorFactory, ReviewSourceView, ReviewSurfaceEvent } from "../common/reviewProtocol.js";
import { ReviewEditorSelections } from "../contrib/verbs/reviewEditorSelections.js";
import { reviewCanvasDiffFactories, type ReviewSourceRead } from "../services/reviewApiSourceContent.js";
import { ReviewDiffViewService } from "../services/reviewDiffViewService.js";
import { ReviewEmbeddedEditors } from "../services/reviewEmbeddedEditors.js";
import { createReviewWebServices, type ReviewWebTheme } from "./reviewWebServices.js";

export interface ReviewWebDiffOptions {
	/** The review server's origin, such as `http://192.168.1.20:8080`. */
	serverUrl: string;
	/** The canvas theme; the editors follow it. */
	theme: ReviewWebTheme;
	/** Sent as `x-review-token` when the server requires one. */
	token?: string;
	/** Opens a review source file, for the diff's "open file" action. */
	openFile?(resource: URI): void;
}

export interface ReviewWebDiffForReview {
	inlineEditors: ReviewInlineEditorFactory;
	diffView: ReviewDiffViewFactory;
	/** Call after the review's source view changes, as Desktop does. */
	openStructuralComparison(): void;
}

export interface ReviewWebDiff {
	forReview(view: () => ReviewSourceView): ReviewWebDiffForReview;
	setTheme(theme: ReviewWebTheme): void;
	structuralDiffEnabled(): boolean;
	setStructuralDiffEnabled(enabled: boolean): Promise<void>;
	currentDiffLayout(): ReviewDiffLayout;
	setDiffLayout(layout: ReviewDiffLayout): Promise<void>;
	onDidChangeDiffLayout(listener: (layout: ReviewDiffLayout) => void): { dispose(): void };
	/** The reader's selection in a peek or the Diff view, as Desktop reports it to the canvas. */
	onDidChangeSelection(listener: (event: Extract<ReviewSurfaceEvent, { event: "editorSelectionChanged" }>) => void): IDisposable;
	dispose(): void;
}

// The diff computation runs in the editor worker, emitted beside this bundle.
function installEditorWorker(): void {
	const global = globalThis as { MonacoEnvironment?: IMonacoEnvironment };
	if (global.MonacoEnvironment?.getWorker || global.MonacoEnvironment?.getWorkerUrl) return;
	const workerUrl = new URL("./workerMain.js", import.meta.url).href;
	global.MonacoEnvironment = { ...global.MonacoEnvironment, getWorker: (_moduleId, label) => new Worker(workerUrl, { type: "module", name: label }) };
}

export function createReviewWebDiff(options: ReviewWebDiffOptions): ReviewWebDiff {
	installEditorWorker();
	const serverUrl = options.serverUrl.replace(/\/$/, "");
	const headers = options.token ? { "x-review-token": options.token } : undefined;
	const connection = { getConnection: async () => ({ serverUrl, token: options.token ?? "" }) };
	const read: ReviewSourceRead = async (reviewId, route, query) => {
		const params = new URLSearchParams(
			Object.entries(query)
				.filter(([key, value]) => key !== "reviewId" && value !== undefined)
				.map(([key, value]) => [key, String(value)]),
		);
		const response = await fetch(`${serverUrl}/reviews-api/${encodeURIComponent(reviewId)}${route}?${params}`, {
			headers,
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`Could not read pinned source (${response.status}).`);
		return response.json();
	};

	const store = new DisposableStore();
	const services = store.add(createReviewWebServices({ read, theme: options.theme, openFile: resource => options.openFile?.(resource) }));
	const instantiation = services.instantiation;
	const inlineEditors = store.add(instantiation.createInstance(ReviewEmbeddedEditors));
	const diff = store.add(instantiation.createInstance(ReviewDiffViewService, inlineEditors));
	const configuration = instantiation.invokeFunction(accessor => accessor.get(IConfigurationService));
	const selections = store.add(new Emitter<Extract<ReviewSurfaceEvent, { event: "editorSelectionChanged" }>>());
	store.add(new ReviewEditorSelections(instantiation.invokeFunction(accessor => accessor.get(ICodeEditorService)), event => selections.fire(event)));

	return {
		forReview: view => reviewCanvasDiffFactories(read, connection, view, diff),
		setTheme: theme => services.setTheme(theme),
		structuralDiffEnabled: () => diff.structuralRenderingEnabled,
		setStructuralDiffEnabled: enabled => configuration.updateValue(REVIEW_STRUCTURAL_DIFF_SETTING, enabled),
		currentDiffLayout: () => diff.diffLayout.get(),
		setDiffLayout: layout => diff.diffLayout.set(layout),
		onDidChangeDiffLayout: listener => diff.diffLayout.onDidChange(listener),
		onDidChangeSelection: listener => selections.event(listener),
		dispose: () => store.dispose(),
	};
}
