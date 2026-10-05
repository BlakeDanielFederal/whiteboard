/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { deepClone } from '../../../base/common/objects.js';
import { ConfigurationTarget, isConfigurationOverrides, removeFromValueTree, type IConfigurationChangeEvent, type IConfigurationData, type IConfigurationModel, type IConfigurationOverrides, type IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { Configuration, ConfigurationModel } from '../../../platform/configuration/common/configurationModels.js';
import type { ILogService } from '../../../platform/log/common/log.js';
import type { IWorkspaceContextService, Workspace } from '../../../platform/workspace/common/workspace.js';
import { override } from '../remote/guard/reviewRemoteGuard.js';

export type ReviewSourceSide = 'live' | 'base' | 'head';

const SIDES: Record<ReviewSourceSide, string> = { live: 'Live source', base: 'Base source', head: 'Source' };
const PINNED = ['files.readonlyInclude', 'files.readonlyExclude'];
const TITLE = 'window.title';

export interface ReviewSourceTitle {
	readonly side: ReviewSourceSide;
	readonly title: string;
}

export function isReviewSourceTitle(value: unknown): value is ReviewSourceTitle {
	const { side, title } = (value ?? {}) as Partial<Record<keyof ReviewSourceTitle, unknown>>;
	return typeof side === 'string' && Object.hasOwn(SIDES, side) && typeof title === 'string';
}

const within = (key: string, section: string) => key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`);

function without(model: IConfigurationModel, keys: readonly string[]): IConfigurationModel {
	const contents = deepClone(model.contents);
	const overrides = model.overrides.map(entry => ({ ...entry, contents: deepClone(entry.contents) }));
	for (const key of keys) {
		for (const tree of [contents, ...overrides.map(entry => entry.contents)]) removeFromValueTree(tree, key);
	}
	return { contents, overrides, keys: model.keys.filter(key => !keys.some(pinned => within(pinned, key))) };
}

export interface ReviewSourceWindowConfiguration<T> {
	readonly service: T;
	setTitle(title: ReviewSourceTitle): void;
}

/**
 * A Source window's settings: no workspace or folder can lower its read-only
 * rule, a Whiteboard host's window reads no workspace, folder or remote machine
 * settings, and `setTitle` sets the title above every layer.
 */
export function reviewSourceWindowConfiguration<T extends IConfigurationService & IWorkspaceContextService>(base: T, logService: ILogService, remote: boolean): ReviewSourceWindowConfiguration<T> {
	let source: ReviewSourceTitle | undefined;
	let cached: Configuration | undefined;
	const changed = new Emitter<IConfigurationChangeEvent>();
	const data = (): IConfigurationData => {
		const empty = ConfigurationModel.createEmptyModel(logService).toJSON();
		const window = base.getConfigurationData() ?? { defaults: empty, policy: empty, application: empty, userLocal: empty, userRemote: empty, workspace: empty, folders: [] };
		return {
			...window,
			userRemote: remote ? empty : window.userRemote,
			workspace: remote ? empty : without(window.workspace, PINNED),
			folders: remote ? [] : window.folders.map(([folder, model]) => [folder, without(model, PINNED)]),
		};
	};
	const title = () => source && `${source.title} — ${SIDES[source.side]} — Whiteboard`;
	const configuration = () => {
		if (!cached) {
			cached = Configuration.parse(data(), logService);
			const value = title();
			if (value) cached.updateValue(TITLE, value);
		}
		return cached;
	};
	const ours = (section: string | undefined) => remote || section === undefined || [...PINNED, ...(title() ? [TITLE] : [])].some(key => within(key, section));
	const workspace = () => base.getWorkspace() as Workspace;
	base.onDidChangeConfiguration(() => cached = undefined);
	return {
		service: override(base, {
			getConfigurationData: data,
			getValue: ((arg1?: unknown, arg2?: unknown) => {
				const section = typeof arg1 === 'string' ? arg1 : undefined;
				const overrides = isConfigurationOverrides(arg1) ? arg1 : isConfigurationOverrides(arg2) ? arg2 : {};
				return ours(section) ? configuration().getValue(section, overrides, workspace()) : (base.getValue as (arg1?: unknown, arg2?: unknown) => unknown)(arg1, arg2);
			}) as T['getValue'],
			inspect: ((key: string, overrides: IConfigurationOverrides = {}) => ours(key) ? configuration().inspect(key, overrides, workspace()) : base.inspect(key, overrides)) as T['inspect'],
			onDidChangeConfiguration: Event.any(base.onDidChangeConfiguration, changed.event),
		} as Partial<T>),
		setTitle(next) {
			if (source?.side === next.side && source.title === next.title) return;
			source = { side: next.side, title: next.title };
			cached = undefined;
			changed.fire({ source: ConfigurationTarget.MEMORY, change: { keys: [TITLE], overrides: [] }, affectedKeys: new Set([TITLE]), affectsConfiguration: section => within(TITLE, section) });
		},
	};
}
