/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionIdentifier, type IExtensionDescription } from "../../../../platform/extensions/common/extensions.js";
import type { IExtensionService } from "../../../../workbench/services/extensions/common/extensions.js";
import { override } from "./reviewRemoteGuard.js";

export function reviewRemoteExtensionService(
	base: IExtensionService,
	extensions: () => readonly IExtensionDescription[],
	activate: (event: string) => Promise<void>,
): IExtensionService {
	return override(base, {
		get extensions() {
			return extensions();
		},
		activateByEvent: (event) => activate(event),
		activationEventIsDone: () => false,
		whenInstalledExtensionsRegistered: async () => true,
		getExtension: async (id) => extensions().find((extension) => ExtensionIdentifier.equals(extension.identifier, id)),
	});
}
