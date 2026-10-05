/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../base/common/lifecycle.js";
import { ILanguageFeaturesService } from "../../../editor/common/services/languageFeatures.js";
import { ExtensionIdentifierSet, type ExtensionIdentifier, type IExtensionDescription } from "../../../platform/extensions/common/extensions.js";
import { IFileService } from "../../../platform/files/common/files.js";
import type { IInstantiationService } from "../../../platform/instantiation/common/instantiation.js";
import { ILogService } from "../../../platform/log/common/log.js";
import { IRemoteAuthorityResolverService } from "../../../platform/remote/common/remoteAuthorityResolver.js";
import { IWorkspaceContextService } from "../../../platform/workspace/common/workspace.js";
import { ExtensionHostManager } from "../../../workbench/services/extensions/common/extensionHostManager.js";
import type { IExtensionHostManager } from "../../../workbench/services/extensions/common/extensionHostManagers.js";
import { ActivationKind, ExtensionHostExtensions, IExtensionService, type IExtensionHost, type IInternalExtensionService } from "../../../workbench/services/extensions/common/extensions.js";
import { RemoteExtensionHost } from "../../../workbench/services/extensions/common/remoteExtensionHost.js";
import { isReviewRemoteAuthority, override, ReviewRemoteRefusals } from "./guard/reviewRemoteGuard.js";
import { ownsRemoteResource, reviewRemoteScope } from "./reviewRemoteScope.js";

const PREFIX = "whiteboard+";

/** The guard scope of a Source window bound to a Whiteboard host; the whole window is that host's. */
export function reviewRemoteWindowScope(input: {
	authority: string;
	services: IInstantiationService;
	activate: (event: string) => Promise<void>;
}): IInstantiationService {
	const { authority, services } = input;
	return services.createChild(services.invokeFunction((window) => {
		const extensionService = window.get(IExtensionService);
		return reviewRemoteScope({
			authority,
			refusals: new ReviewRemoteRefusals(authority, () => authority.slice(PREFIX.length, PREFIX.length + 8), window.get(ILogService)),
			extensions: () => extensionService.extensions.filter((extension) => ownsRemoteResource(authority, extension.extensionLocation)),
			activate: input.activate,
			languageFeatures: window.get(ILanguageFeaturesService),
			workspace: window.get(IWorkspaceContextService),
			resolver: window.get(IRemoteAuthorityResolverService),
			ownFiles: window.get(IFileService),
		}, window);
	}));
}

/**
 * Rebuilds a Whiteboard host's remote extension host and its manager inside the
 * guard scope, told only of that host's own extensions. Other hosts: undefined.
 */
export class ReviewRemoteWindowExtensionHosts extends Disposable {
	private scope: IInstantiationService | undefined;
	private manager: ExtensionHostManager | undefined;

	constructor(private readonly services: IInstantiationService) {
		super();
	}

	create(extensionHost: IExtensionHost, initialActivationEvents: string[], internal: IInternalExtensionService): IExtensionHostManager | undefined {
		if (!(extensionHost instanceof RemoteExtensionHost) || !isReviewRemoteAuthority(extensionHost.remoteAuthority)) return undefined;
		const authority = extensionHost.remoteAuthority;
		this.scope ??= this._register(reviewRemoteWindowScope({
			authority,
			services: this.services,
			activate: async (event) => { await this.manager?.activateByEvent(event, ActivationKind.Normal); },
		}));
		const mine = (extension: IExtensionDescription) => ownsRemoteResource(authority, extension.extensionLocation);
		const provider = extensionHost._initDataProvider;
		const host = this.scope.createInstance(RemoteExtensionHost, extensionHost.runningLocation, {
			...provider,
			getInitData: async () => {
				const data = await provider.getInitData();
				const own = data.extensions.allExtensions.filter(mine);
				const ids = new ExtensionIdentifierSet(own.map((extension) => extension.identifier));
				return { ...data, extensions: new ExtensionHostExtensions(data.extensions.versionId, own, data.extensions.myExtensions.filter((id) => ids.has(id))) };
			},
		});
		extensionHost.dispose();
		const manager = (this.manager = this.scope.createInstance(ExtensionHostManager, host, initialActivationEvents, internal));
		const known = (added: readonly IExtensionDescription[]) => new ExtensionIdentifierSet([...(host.extensions?.allExtensions ?? []), ...added].map((extension) => extension.identifier));
		return override<IExtensionHostManager>(manager, {
			start: (versionId, allExtensions, myExtensions) => {
				const own = allExtensions.filter(mine);
				const ids = known(own);
				return manager.start(versionId, own, myExtensions.filter((id) => ids.has(id)));
			},
			deltaExtensions: (delta) => {
				const toAdd = delta.toAdd.filter(mine);
				const ids = known(toAdd);
				const has = (id: ExtensionIdentifier | string) => ids.has(id);
				return manager.deltaExtensions({
					versionId: delta.versionId,
					toRemove: delta.toRemove.filter(has),
					toAdd,
					addActivationEvents: Object.fromEntries(Object.entries(delta.addActivationEvents).filter(([id]) => has(id))),
					myToRemove: delta.myToRemove.filter(has),
					myToAdd: delta.myToAdd.filter(has),
				});
			},
		});
	}
}
