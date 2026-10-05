/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAction } from "../../../../base/common/actions.js";
import type { IProgressService } from "../../../../platform/progress/common/progress.js";
import { override, type ReviewRemoteRefusals } from "./reviewRemoteGuard.js";

type Options = Parameters<IProgressService["withProgress"]>[0];

export function reviewRemoteProgressService(base: IProgressService, refusals: ReviewRemoteRefusals): IProgressService {
	const text = (value: string | undefined) => (value === undefined ? undefined : refusals.text(value));
	const actions = (value: readonly IAction[] | undefined) => value?.filter((action) => typeof action.run === "function");
	const clean = (options: Options): Options => {
		const o = options as Options & { command?: string; detail?: string; primaryActions?: readonly IAction[]; secondaryActions?: readonly IAction[]; delay?: number; sticky?: boolean; priority?: number; type?: "loading" | "syncing" };
		if (o.command !== undefined) refusals.refuse("commands in progress a remote shows");
		const source = typeof o.source === "string" ? refusals.text(o.source) : o.source && { id: o.source.id, label: refusals.text(o.source.label) };
		const rebuilt = {
			location: o.location,
			title: text(o.title),
			source,
			total: o.total,
			cancellable: typeof o.cancellable === "string" ? refusals.text(o.cancellable) : o.cancellable,
			buttons: o.buttons?.map((button) => refusals.text(button)),
			detail: text(o.detail),
			delay: o.delay,
			sticky: o.sticky,
			priority: o.priority,
			type: o.type,
			primaryActions: actions(o.primaryActions),
			secondaryActions: actions(o.secondaryActions),
		};
		return Object.fromEntries(Object.entries(rebuilt).filter(([, value]) => value !== undefined)) as unknown as Options;
	};
	return override(base, {
		withProgress: (options, task, onDidCancel) =>
			base.withProgress(
				clean(options),
				(progress) => task({ report: (step) => progress.report({ message: text(step.message), increment: step.increment, total: step.total }) }),
				onDidCancel,
			),
	});
}
