/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IExtensionsWorkbenchService } from "../../../../workbench/contrib/extensions/common/extensions.js";
import { override, type ReviewRemoteRefusals } from "./reviewRemoteGuard.js";

const KIND = "managing the window's extensions";

export function reviewRemoteExtensionsWorkbenchService(base: IExtensionsWorkbenchService, refusals: ReviewRemoteRefusals): IExtensionsWorkbenchService {
	const none = async () => {
		refusals.refuse(KIND);
		return [];
	};
	return override(base, {
		...refusals.refuseAll<IExtensionsWorkbenchService>(
			["install", "installInServer", "uninstall", "setEnablement", "updateAll", "updateRunningExtensions", "togglePreRelease", "downloadVSIX", "open", "openSearch"],
			KIND,
		),
		queryLocal: none,
		getExtensions: none,
		getResourceExtensions: none,
		queryGallery: async () => {
			throw refusals.refuse(KIND);
		},
	});
}
