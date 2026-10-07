/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from "../../base/common/event.js";
import { ImmortalReference, toDisposable, type IDisposable, type IReference } from "../../base/common/lifecycle.js";
import type { URI } from "../../base/common/uri.js";
import type { ITextModel, ITextSnapshot } from "../../editor/common/model.js";
import { IModelService } from "../../editor/common/services/model.js";
import type { IResolvedTextEditorModel, ITextModelContentProvider, ITextModelService } from "../../editor/common/services/resolverService.js";

/** A review source model: always resolved and never edited. */
class ReviewWebTextModel implements IResolvedTextEditorModel {
	private readonly willDispose = new Emitter<void>();
	private disposed = false;

	constructor(readonly textEditorModel: ITextModel) { }

	get onWillDispose(): Event<void> {
		return this.willDispose.event;
	}

	async resolve(): Promise<void> { }

	createSnapshot(): ITextSnapshot {
		return this.textEditorModel.createSnapshot();
	}

	isReadonly(): boolean {
		return true;
	}

	getLanguageId(): string | undefined {
		return this.textEditorModel.getLanguageId();
	}

	isResolved(): boolean {
		return true;
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	dispose(): void {
		this.disposed = true;
		this.willDispose.fire();
		this.willDispose.dispose();
	}
}

/**
 * The workbench's model resolver without its file service: models come from
 * the registered content providers, or from models that already exist.
 */
export class ReviewWebTextModelService implements ITextModelService {
	declare readonly _serviceBrand: undefined;

	private readonly providers = new Map<string, ITextModelContentProvider>();
	private readonly pending = new Map<string, Promise<ITextModel>>();

	constructor(@IModelService private readonly modelService: IModelService) { }

	async createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
		return new ImmortalReference(new ReviewWebTextModel(await this.resolveModel(resource)));
	}

	registerTextModelContentProvider(scheme: string, provider: ITextModelContentProvider): IDisposable {
		this.providers.set(scheme, provider);
		return toDisposable(() => {
			if (this.providers.get(scheme) === provider) this.providers.delete(scheme);
		});
	}

	canHandleResource(resource: URI): boolean {
		return this.providers.has(resource.scheme);
	}

	private resolveModel(resource: URI): Promise<ITextModel> {
		const existing = this.modelService.getModel(resource);
		if (existing) return Promise.resolve(existing);
		const key = resource.toString();
		// The original and modified sides, and several peeks, can ask for one file at once.
		const inFlight = this.pending.get(key);
		if (inFlight) return inFlight;
		const provider = this.providers.get(resource.scheme);
		if (!provider) return Promise.reject(new Error(`No content provider for ${resource.scheme} resources.`));
		const request = Promise.resolve(provider.provideTextContent(resource)).then(model => {
			if (!model) throw new Error(`No content for ${key}.`);
			return model;
		}).finally(() => this.pending.delete(key));
		this.pending.set(key, request);
		return request;
	}
}
