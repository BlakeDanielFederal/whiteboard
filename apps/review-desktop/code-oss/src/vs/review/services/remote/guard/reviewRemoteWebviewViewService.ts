/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IWebviewViewService } from "../../../../workbench/contrib/webviewView/browser/webviewViewService.js";
import { override, type ReviewRemoteRefusals } from "./reviewRemoteGuard.js";

export function reviewRemoteWebviewViewService(base: IWebviewViewService, refusals: ReviewRemoteRefusals): IWebviewViewService {
	return override(base, refusals.refuseAll<IWebviewViewService>(["register", "resolve"], "showing webviews"));
}
