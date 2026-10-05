/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../base/common/lifecycle.js";
import type { ILanguageStatusService } from "../../../../workbench/services/languageStatus/common/languageStatusService.js";
import { override, type ReviewRemoteRefusals } from "./reviewRemoteGuard.js";

export function reviewRemoteLanguageStatusService(base: ILanguageStatusService, refusals: ReviewRemoteRefusals): ILanguageStatusService {
	return override(base, {
		addStatus: () => {
			refusals.refuse("showing language status items");
			return Disposable.None;
		},
	});
}
