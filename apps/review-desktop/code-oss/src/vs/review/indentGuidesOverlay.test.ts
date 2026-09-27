/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ load(url, context, next) {
	return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });

const { IndentGuidesOverlay } = await import('../editor/browser/viewParts/indentGuides/indentGuides.js');

test('skips an explicit-column guide when its view position is unavailable', () => {
	const overlay = Object.create(IndentGuidesOverlay.prototype) as InstanceType<typeof IndentGuidesOverlay>;
	Object.assign(overlay, {
		_bracketPairGuideOptions: { indentation: true, bracketPairs: false },
		_context: { viewModel: { getLineCount: () => 1 } },
		_primaryPosition: null,
		_spaceWidth: 8,
		_maxIndentLeft: -1,
		getGuidesByLine: () => [[
			{ visibleColumn: -1, column: 5, className: 'unavailable', horizontalLine: { top: true, endColumn: 7 } },
			{ visibleColumn: -1, column: 8, className: 'available', horizontalLine: { top: true, endColumn: 9 } },
		]],
	});
	const ctx = {
		visibleRange: { startLineNumber: 1, endLineNumber: 1 },
		scrollWidth: 100,
		visibleRangeForPosition: (position: { column: number }) => position.column === 5 ? null : { left: position.column * 8 },
	} as never;

	assert.doesNotThrow(() => overlay.prepareRender(ctx));
	assert.equal(overlay.render(1, 1), '<div class="core-guide available horizontal-top" style="left:64px;width:8px"></div>');
});
