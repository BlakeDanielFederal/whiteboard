/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from "../../../../base/common/event.js";
import { isMarkdownString, type IMarkdownString } from "../../../../base/common/htmlContent.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import type { IExtensionStatusBarItemService } from "../../../../workbench/api/browser/statusBarExtensionPoint.js";
import { ReviewRemoteCommandService } from "./reviewRemoteCommandService.js";
import { IReviewRemoteRefusals, type ReviewRemoteRefusals } from "./reviewRemoteGuard.js";

type Tooltip = Parameters<IExtensionStatusBarItemService["setOrUpdateEntry"]>[5];

export class ReviewRemoteStatusBarItemService implements IExtensionStatusBarItemService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChange = Event.None;
	private readonly commands: ReviewRemoteCommandService;
	private readonly mine = new Set<string>();

	constructor(
		private readonly base: IExtensionStatusBarItemService,
		@ICommandService commands: ICommandService,
		@IReviewRemoteRefusals private readonly refusals: ReviewRemoteRefusals,
	) {
		if (!(commands instanceof ReviewRemoteCommandService)) throw new Error("A remote host's scope has no guarded command service.");
		this.commands = commands;
	}

	private text(value: string | IMarkdownString | undefined) {
		return value === undefined ? undefined : isMarkdownString(value) ? this.refusals.markdown(value) : this.refusals.text(value);
	}

	private tooltip(tooltip: Tooltip): Tooltip {
		if (tooltip === undefined || typeof tooltip === "string" || isMarkdownString(tooltip)) return this.text(tooltip);
		const { markdown } = tooltip;
		return {
			markdownNotSupportedFallback: tooltip.markdownNotSupportedFallback && this.refusals.text(tooltip.markdownNotSupportedFallback),
			markdown: typeof markdown === "function" ? async (token) => this.text(await markdown(token)) : this.text(markdown),
		};
	}

	setOrUpdateEntry(...[id, statusId, extensionId, name, text, tooltip, command, ...rest]: Parameters<IExtensionStatusBarItemService["setOrUpdateEntry"]>) {
		if (!this.mine.has(id) && [...this.base.getEntries()].some(([entry]) => entry === id)) throw this.refusals.refuse("changing the window's status bar items");
		this.mine.add(id);
		return this.base.setOrUpdateEntry(id, statusId, extensionId, name, text, this.tooltip(tooltip), command && this.commands.relay(command), ...rest);
	}

	unsetEntry(id: string): void {
		if (!this.mine.delete(id)) return;
		this.base.unsetEntry(id);
	}

	getEntries() {
		return [];
	}
}
