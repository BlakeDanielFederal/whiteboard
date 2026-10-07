/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64 } from "../../../base/common/buffer.js";
import { Emitter, Event } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import { ICodeEditorService } from "../../../editor/browser/services/codeEditorService.js";
import { createDecorator } from "../../../platform/instantiation/common/instantiation.js";
import { IOpenerService } from "../../../platform/opener/common/opener.js";
import { IHostService } from "../../../workbench/services/host/browser/host.js";
import {
	type JsonValue,
	parseReviewVerbRequest,
	REVIEW_DISCORD_URL,
	type ReviewSurfaceEvent,
	type ReviewVerbResponse,
	type ReviewView,
} from "../../common/reviewProtocol.js";
import { IReviewApiCatalogService } from "../../services/reviewApiCatalogService.js";
import { IReviewCanvasEditorTabsService } from "../../services/reviewCanvasEditorTabsService.js";
import { ReviewEditorSelections } from "./reviewEditorSelections.js";

export const IReviewVerbsService = createDecorator<IReviewVerbsService>("reviewVerbsService");

export interface IReviewVerbsService {
	readonly _serviceBrand: undefined;
	readonly onDidEmitSurfaceEvent: Event<ReviewSurfaceEvent>;
	readonly onDidRequestCanvasFocus: Event<void>;
	dispatch(value: JsonValue): Promise<ReviewVerbResponse>;
}

export class ReviewVerbsService extends Disposable implements IReviewVerbsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidEmitSurfaceEvent = this._register(new Emitter<ReviewSurfaceEvent>());
	readonly onDidEmitSurfaceEvent = this._onDidEmitSurfaceEvent.event;
	private readonly _onDidRequestCanvasFocus = this._register(new Emitter<void>());
	readonly onDidRequestCanvasFocus = this._onDidRequestCanvasFocus.event;

	constructor(
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IReviewCanvasEditorTabsService
		private readonly tabsService: IReviewCanvasEditorTabsService,
		@IHostService private readonly hostService: IHostService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IReviewApiCatalogService
		private readonly apiCatalog: IReviewApiCatalogService,
	) {
		super();
		this._register(new ReviewEditorSelections(this.codeEditorService, (event) => this._onDidEmitSurfaceEvent.fire(event)));
	}

	async dispatch(value: JsonValue): Promise<ReviewVerbResponse> {
		try {
			const request = parseReviewVerbRequest(value);
			switch (request.name) {
				case "joinDiscord":
					await this.openerService.open(REVIEW_DISCORD_URL, { openExternal: true });
					break;
				case "showReviewView":
					await this.showReviewView(request.args.view);
					break;
				case "openSourceTree":
				case "openDiff":
				case "reveal":
				case "openReviewRevision":
					throw new Error("This action requires a pinned session canvas.");
				case "captureScreenshot":
					return { ok: true, result: await this.captureScreenshot() };
				case "openReview": {
					const review = this.apiCatalog.reviews.find((review) => review.reviewId === request.args.reviewUuid);
					if (!review) throw new Error("Review not found. If this is an old Whiteboard review, ask your agent to migrate your old Whiteboard reviews.");
					await this.tabsService.openApiReview(review.reviewId, review.title, request.args.active);
					break;
				}
				case "openApiReview":
					await this.tabsService.openApiReview(request.args.reviewId, request.args.title);
					break;
			}
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async captureScreenshot(): Promise<{ dataUrl: string } | undefined> {
		try {
			const screenshot = await this.hostService.getScreenshot();
			if (!screenshot) return undefined;
			return {
				dataUrl: `data:image/jpeg;base64,${encodeBase64(screenshot)}`,
			};
		} catch {
			return undefined;
		}
	}

	/**
	 * The dispatcher reveals the Review tab before asking the app to show a view.
	 */
	private async showReviewView(view: ReviewView): Promise<void> {
		this._onDidRequestCanvasFocus.fire();
		this._onDidEmitSurfaceEvent.fire({ event: "showReviewView", view });
	}
}
