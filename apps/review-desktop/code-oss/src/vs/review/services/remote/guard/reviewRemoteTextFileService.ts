/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import type { URI } from "../../../../base/common/uri.js";
import type { ITextFileEditorModelManager, ITextFileService } from "../../../../workbench/services/textfile/common/textfiles.js";
import type { IUntitledTextEditorModelManager } from "../../../../workbench/services/untitled/common/untitledTextEditorService.js";
import { override, type ReviewRemoteRefusals } from "./reviewRemoteGuard.js";

export function reviewRemoteTextFileService(base: ITextFileService, refusals: ReviewRemoteRefusals): ITextFileService {
	const mine = (resource: URI | undefined) => !!resource && refusals.owns(resource);
	const own = <T>(resource: URI | undefined, read: () => Promise<T>): Promise<T> =>
		mine(resource) ? read() : Promise.reject(refusals.refuse("reading files outside this remote"));
	return override(base, {
		...refusals.refuseAll<ITextFileService>(["save", "saveAs", "revert", "write", "create"], "saving or changing files"),
		read: (resource, options) => own(resource, () => base.read(resource, options)),
		readStream: (resource, options) => own(resource, () => base.readStream(resource, options)),
		resolveDecoding: (resource, options) => own(resource, () => base.resolveDecoding(resource, options)),
		resolveEncoding: (resource, options) => own(resource, () => base.resolveEncoding(resource, options)),
		validateDetectedEncoding: (resource, detected, options) => own(resource, () => base.validateDetectedEncoding(resource, detected, options)),
		files: override<ITextFileEditorModelManager>(base.files, {
			resolve: (resource, options) => own(resource, () => base.files.resolve(resource, options)),
			addSaveParticipant: () => Disposable.None,
			onDidSave: Event.filter(base.files.onDidSave, (e) => mine(e.model.resource)),
			onDidChangeDirty: Event.filter(base.files.onDidChangeDirty, (model) => mine(model.resource)),
			onDidChangeEncoding: Event.filter(base.files.onDidChangeEncoding, (model) => mine(model.resource)),
		}),
		untitled: override<IUntitledTextEditorModelManager>(base.untitled, {
			...refusals.refuseAll<IUntitledTextEditorModelManager>(["create", "resolve"], "creating untitled documents"),
			onDidChangeEncoding: Event.None,
		}),
	});
}
