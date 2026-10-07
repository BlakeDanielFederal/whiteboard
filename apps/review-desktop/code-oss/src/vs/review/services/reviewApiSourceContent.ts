/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// The review source models and diff factories, independent of where the server
// connection comes from: Desktop's workbench and the browser host both use them.

import { URI } from "../../base/common/uri.js";
import type { ILanguageService } from "../../editor/common/languages/language.js";
import type { ITextModel } from "../../editor/common/model.js";
import type { IModelService } from "../../editor/common/services/model.js";
import type { ITextModelContentProvider } from "../../editor/common/services/resolverService.js";
import { orderReviewDiffFiles } from "../common/reviewChangedFilesModel.js";
import { lensFiles } from "../common/reviewLensFiles.js";
import type {
	ReviewDiffFileWire,
	ReviewDiffLens,
	ReviewDiffViewFactory,
	ReviewInlineEditorFactory,
	ReviewInlineFindSpec,
} from "../common/reviewProtocol.js";
import { reviewSourceAnchor, reviewSourceComparison, reviewSourceQuery, type ReviewSourceView } from "../common/reviewProtocol.js";
import { apiSourceUri, sourceLocation } from "../common/reviewSourceView.js";
import type { ReviewDiffViewService, ReviewDiffViewSource } from "./reviewDiffViewService.js";
import { StructuralDiffClient, type ReviewServerEndpoint } from "./reviewStructuralDiffClient.js";

/** Reads one JSON route of a review from the review server. */
export type ReviewSourceRead = <T>(
	reviewId: string,
	route: string,
	query: Record<string, string | number | undefined>,
) => Promise<T>;

/** The query that distinguishes one comparison's diff models from another's. */
function comparisonQuery(view: ReviewSourceView): string | undefined {
	const params = new URLSearchParams();
	if (view.commit) params.set("commit", view.commit);
	if (view.pins) {
		params.set("repositoryId", view.pins.repositoryId);
		params.set("head", view.pins.head);
		if (view.pins.base) params.set("base", view.pins.base);
	}
	const query = params.toString();
	return query || undefined;
}

/**
 * Text models for `review-api-source` URIs, read at the review's pins. `followLocal`
 * keeps a live checkout's model current when the host can watch that file.
 */
export function reviewApiSourceContentProvider(
	modelService: IModelService,
	languages: ILanguageService,
	read: ReviewSourceRead,
	followLocal?: (model: ITextModel, localPath: string, reread: () => Promise<string>) => void,
): ITextModelContentProvider {
	return {
		provideTextContent: async (resource) => {
			const existing = modelService.getModel(resource);
			if (existing) return existing;
			const query = new URLSearchParams(resource.query);
			const target = sourceLocation(resource);
			const body: { text: string; localPath?: string; binary?: false } | { binary: true } = query.has("empty")
				? { text: "" }
				: await read(target.view.reviewId, "/file", { ...reviewSourceQuery(target.view), side: target.side, file: target.file, binary: "describe" });
			// Opening a binary from the source tree shows this notice instead of
			// its bytes; the diff never asks, since binary entries read as empty.
			// Authoring still refuses binaries as code references.
			const text = body.binary ? "Binary file cannot be displayed as text." : body.text;
			const model = (
				modelService.getModel(resource) ??
				modelService.createModel(
					text,
					body.binary ? languages.createById("plaintext") : languages.createByFilepathOrFirstLine(resource, text.split("\n", 1)[0]),
					resource,
				)
			);
			if (!body.binary && body.localPath && followLocal) {
				followLocal(model, body.localPath, async () => (await read<{ text: string }>(target.view.reviewId, "/file", { ...reviewSourceQuery(target.view), side: target.side, file: target.file })).text);
			}
			return model;
		},
	};
}

/** The canvas's inline editors and diff view for one review, backed by `diff`. */
export function reviewCanvasDiffFactories(
	read: ReviewSourceRead,
	connection: ReviewServerEndpoint,
	view: () => ReviewSourceView,
	diff: ReviewDiffViewService,
) {
	const comparisonGeneration = diff.comparisonGeneration;
	// A live checkout's saves change its generation; each comparison keeps only the latest.
	const lists = new Map<string, { generation?: string; list: Promise<readonly ReviewDiffFileWire[]> }>();
	const files = (current: ReviewSourceView) => {
		const key = JSON.stringify(reviewSourceQuery(current));
		const cached = lists.get(key);
		if (cached && cached.generation === current.generation) return cached.list;
		const list = read<ReviewDiffFileWire[]>(current.reviewId, "/diff", reviewSourceQuery(current));
		list.catch(() => { if (lists.get(key)?.list === list) lists.delete(key); });
		lists.set(key, { generation: current.generation, list });
		return list;
	};
	const openComparison = (current: ReviewSourceView) => diff.openComparison(
		JSON.stringify(reviewSourceQuery(current)), new StructuralDiffClient(connection, current), comparisonGeneration, current.generation,
	);
	const makeSource = (getView: () => ReviewSourceView): ReviewDiffViewSource => ({
		files: scope => files(reviewSourceComparison(getView(), scope?.commit)),
		load: async (scope, lens) => {
			if (lens && (scope || lens.reviewId !== getView().reviewId)) throw new Error("A lens must use its review comparison.");
			// Capture the comparison once; live checkout bytes may change during the load.
			const current = reviewSourceComparison(getView(), scope?.commit);
			const comparisonFiles = await files(current);
			const entries = lens ? lensFiles(comparisonFiles, lens).filter(file => lens.ranges.some(range =>
				range.file === (range.side === "base" ? file.previousPath ?? file.path : file.path))) : orderReviewDiffFiles(comparisonFiles);

			return {
				session: openComparison(current),
				stateKey: JSON.stringify([current.reviewId, reviewSourceQuery(current)]),
				sourceUri: URI.from({ scheme: "review-api-diff", authority: current.reviewId, path: `/${current.version}/${current.generation ?? ""}`, query: comparisonQuery(current) }),
				entries: entries.map(file => {
					// A binary's sides read as empty: it stays folded, so nothing fetches its bytes.
					const original = file.status === "added" ? undefined : apiSourceUri({ view: current, side: "base", file: file.previousPath ?? file.path }, !!file.binary);
					const modified = file.status === "deleted" ? undefined : apiSourceUri({ view: current, side: "head", file: file.path }, !!file.binary);
					return { file, original, modified, goToFileResource: (modified ?? original)! };
				}),
			};
		},
	});
	const diffSource = makeSource(view);
	const documentScope = (spec: ReviewInlineFindSpec) => {
		// A source with its own pins is read at them; the review comparison does not apply.
		const current = spec.pins ? reviewSourceAnchor(view(), spec.pins) : reviewSourceComparison(view());
		const lens: ReviewDiffLens = {
			id: "document:" + JSON.stringify([spec.path, spec.ranges, spec.pins]), title: spec.path,
			reviewId: current.reviewId, version: current.version,
			ranges: spec.ranges.map(range => ({ file: spec.path, side: range.side ?? spec.side, fromLine: range.startLine, toLine: range.endLine })),
		};
		return { lens, source: makeSource(() => current) };
	};
	return {
		openStructuralComparison: () => diff.structuralRenderingEnabled ? openComparison(reviewSourceComparison(view())) : undefined,
		inlineEditors: {
			create: (spec) => { const { lens, source } = documentScope(spec); return diff.createDocument(spec, lens, source); },
			find: async (spec, query) => { const { lens, source } = documentScope(spec); return { matchCount: (await diff.findDocument(lens, source, query)).length }; },
		} satisfies ReviewInlineEditorFactory,
		diffView: {
			create: (spec) => diff.create(spec, diffSource),
			files: diffSource.files,
		} satisfies ReviewDiffViewFactory,
	};
}
