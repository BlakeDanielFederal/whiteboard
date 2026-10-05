/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ILanguagePackService } from "../../../../platform/languagePacks/common/languagePacks.js";
import { override } from "./reviewRemoteGuard.js";

export function reviewRemoteLanguagePackService(base: ILanguagePackService): ILanguagePackService {
	return override(base, { getBuiltInExtensionTranslationsUri: async () => undefined });
}
