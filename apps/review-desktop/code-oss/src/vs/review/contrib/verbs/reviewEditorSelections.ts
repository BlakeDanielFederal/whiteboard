/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap, DisposableStore, type IDisposable } from "../../../base/common/lifecycle.js";
import type { ICodeEditor, IDiffEditor } from "../../../editor/browser/editorBrowser.js";
import type { ICodeEditorService } from "../../../editor/browser/services/codeEditorService.js";
import type { ReviewSurfaceEvent } from "../../common/reviewProtocol.js";
import { apiSourceTarget } from "../../services/reviewApiSourceService.js";
import { apiSelectionEvent } from "./reviewApiSelection.js";
import { selectedMonacoDiff } from "./reviewDiffSelection.js";

type EditorSelectionEvent = Extract<ReviewSurfaceEvent, { event: "editorSelectionChanged" }>;

/**
 * Reports the reader's selection in any review source editor, with the diff
 * it covers, as the canvas's `editorSelectionChanged` event. Desktop's verbs
 * service and the browser diff library both run it.
 */
export class ReviewEditorSelections extends Disposable {
	private readonly selectionEditors = this._register(new DisposableMap<string, DisposableStore>());
	private readonly diffSelections = this._register(new DisposableMap<IDiffEditor, IDisposable>());

	constructor(
		private readonly codeEditorService: ICodeEditorService,
		private readonly emit: (event: EditorSelectionEvent) => void,
	) {
		super();
		for (const editor of this.codeEditorService.listCodeEditors()) this.trackSelection(editor);
		for (const diff of this.codeEditorService.listDiffEditors()) this.trackDiffSelection(diff);
		this._register(this.codeEditorService.onDiffEditorAdd(diff => this.trackDiffSelection(diff)));
		this._register(this.codeEditorService.onDiffEditorRemove(diff => this.diffSelections.deleteAndDispose(diff)));
		this._register(this.codeEditorService.onCodeEditorAdd((editor) => this.trackSelection(editor)));
		this._register(this.codeEditorService.onCodeEditorRemove((editor) => this.selectionEditors.deleteAndDispose(editor.getId())));
	}

	private trackDiffSelection(diff: IDiffEditor): void {
		this.diffSelections.set(diff, diff.onDidUpdateDiff(() => {
			this.emitSelection(diff.getOriginalEditor());
			this.emitSelection(diff.getModifiedEditor());
		}));
	}

	private trackSelection(editor: ICodeEditor): void {
		if (this.selectionEditors.has(editor.getId())) return;
		const store = new DisposableStore();
		this.selectionEditors.set(editor.getId(), store);
		store.add(editor.onDidChangeCursorSelection(() => this.emitSelection(editor)));
		store.add(editor.onDidFocusEditorText(() => this.emitSelection(editor)));
		store.add(editor.onDidScrollChange(() => this.emitSelection(editor)));
	}

	private emitSelection(editor: ICodeEditor): void {
		if (!editor.hasTextFocus()) return;
		const model = editor.getModel();
		const selection = editor.getSelection();
		if (!model || !selection) return;
		const start = selection.getStartPosition();
		const end = selection.getEndPosition();
		const fromLine = start.lineNumber;
		const toLine = Math.max(fromLine, end.lineNumber - (end.column === 1 && end.lineNumber > fromLine ? 1 : 0));
		const rect = editor.getDomNode()?.getBoundingClientRect();
		const position = editor.getScrolledVisiblePosition(selection.getPosition());
		const anchor = rect && position ? { x: rect.left + position.left, y: rect.top + position.top } : undefined;
		const apiSelection = apiSelectionEvent(model.uri, selection, anchor);
		if (!apiSelection) return;
		const diff = this.codeEditorService.listDiffEditors().find(diff => diff.getOriginalEditor() === editor || diff.getModifiedEditor() === editor);
		const models = diff?.getModel();
		const changes = diff?.getLineChanges();
		if (models && changes && !selection.isEmpty()) {
			const oldSource = apiSourceTarget(models.original.uri);
			const newSource = apiSourceTarget(models.modified.uri);
			if (oldSource && newSource) apiSelection.selectedDiff = selectedMonacoDiff(
				models.original, models.modified, changes, apiSelection.sideContext, fromLine, toLine,
				new URLSearchParams(models.original.uri.query).has("empty") ? "" : oldSource.file,
				new URLSearchParams(models.modified.uri.query).has("empty") ? "" : newSource.file,
			);
		}
		this.emit(apiSelection);
	}
}
