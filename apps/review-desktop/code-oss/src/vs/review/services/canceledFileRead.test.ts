import assert from "node:assert/strict";
import test from "node:test";

import { CancellationError } from "../../base/common/errors.js";
import { URI } from "../../base/common/uri.js";
import { FileService } from "../../platform/files/common/fileService.js";
import { FileOperationError } from "../../platform/files/common/files.js";

test("file read cancellation keeps its type while other read failures gain file context", () => {
	const service = new FileService({} as never);
	const restoreReadError = (error: Error) =>
		(service as unknown as {
			restoreReadError(error: Error, resource: URI): Error;
		}).restoreReadError(error, URI.file("/extensions/theme/theme.json"));

	try {
		const cancellation = new CancellationError();
		assert.equal(restoreReadError(cancellation), cancellation);

		const failure = restoreReadError(new Error("disk unavailable"));
		assert.ok(failure instanceof FileOperationError);
		assert.match(failure.message, /Unable to read file/);
		assert.match(failure.message, /disk unavailable/);
	} finally {
		service.dispose();
	}
});
