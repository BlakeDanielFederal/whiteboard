/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { ReviewDesktopChannel } from "./reviewDesktopChannel.js";

const review = "0199a3f2-7c1e-7d4a-9b2f-3e5d6c7b8a90";
const other = "0199a3f2-7c1e-7d4a-9b2f-3e5d6c7b8a91";
const managed = (id: string, rest = "navigator/workspaces/abc/repo.code-workspace") => `/repo/.git/dev-fast/reviews/${id}/${rest}`;

function channelWith(workspaces: Record<string, unknown>) {
	const closed: string[] = [];
	const windows = Object.entries(workspaces).map(([name, openedWorkspace]) => ({
		openedWorkspace,
		close: () => closed.push(name),
	}));
	const channel = new ReviewDesktopChannel({} as never, { getWindows: () => windows } as never, {} as never);
	return { channel, closed };
}

test("closes only the source windows of the given reviews", async () => {
	const { channel, closed } = channelWith({
		main: undefined,
		head: { id: "1", configPath: { path: managed(review) } },
		live: { id: "2", configPath: { path: managed(review, "navigator/workspaces/worktree/repo.code-workspace") } },
		other: { id: "3", configPath: { path: managed(other) } },
		folder: { id: "4", uri: { path: managed(review, "head/abc") } },
		lookalike: { id: "5", configPath: { path: `/repo/.git/dev-fast/reviews/${review}x/repo.code-workspace` } },
		elsewhere: { id: "6", configPath: { path: `/projects/${review}/repo.code-workspace` } },
	});

	await channel.call("", "closeSourceWindows", [review]);

	assert.deepEqual(closed, ["head", "live"]);
});

test("matches a review by the storage segment the host names its directory with", async () => {
	const { channel, closed } = channelWith({ shared: { id: "1", configPath: { path: managed("shared__abc") } } });

	await channel.call("", "closeSourceWindows", ["shared:abc"]);

	assert.deepEqual(closed, ["shared"]);
});

function launchingChannel(picked: string | null = null) {
	const launched: unknown[] = [];
	const launcher = {
		async openUrl(url: string) { launched.push(url); },
		async openInApplication(application: string, filePath: string) { launched.push({ application, filePath }); },
	};
	const dialogs = { async showOpenDialog() { return { canceled: picked === null, filePaths: picked ? [picked] : [] }; } };
	const channel = new ReviewDesktopChannel({} as never, { getWindows: () => [], getFocusedWindow: () => undefined } as never, dialogs as never, launcher);
	return { channel, launched };
}

test("opens only a known editor's file URL from the main process", async () => {
	const { channel, launched } = launchingChannel();

	await channel.call("", "openInExternalEditor", { editor: "cursor", filePath: "/repo/a.ts", line: 3, column: 2 });
	await assert.rejects(channel.call("", "openInExternalEditor", { editor: "whiteboard", filePath: "/repo/a.ts" }));
	await assert.rejects(channel.call("", "openInExternalEditor", { editor: "vscode", filePath: "../a.ts" }));
	await assert.rejects(channel.call("", "openInExternalEditor"));

	assert.deepEqual(launched, ["cursor://file/repo/a.ts:3:2"]);
});

test("opens a file in a picked application only by absolute paths", async () => {
	const { channel, launched } = launchingChannel();

	await channel.call("", "openInApplication", { application: "/Applications/TextEdit.app", filePath: "/repo/a.ts" });
	await assert.rejects(channel.call("", "openInApplication", { application: "TextEdit", filePath: "/repo/a.ts" }));
	await assert.rejects(channel.call("", "openInApplication", { application: "/Applications/TextEdit.app", filePath: "a.ts" }));

	assert.deepEqual(launched, [{ application: "/Applications/TextEdit.app", filePath: "/repo/a.ts" }]);
});

test("the application picker returns the pick, or null when cancelled", async () => {
	assert.equal(await launchingChannel("/Applications/TextEdit.app").channel.call("", "chooseApplication"), "/Applications/TextEdit.app");
	assert.equal(await launchingChannel(null).channel.call("", "chooseApplication"), null);
});
