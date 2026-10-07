// @vitest-environment jsdom
// A web host on a LAN address serves plain HTTP, where browsers withhold
// crypto.randomUUID and navigator.clipboard.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { copyText, setCopyFailureReporter } from "./copy-text";
import { randomId } from "./random-id";

beforeEach(() => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
});

afterEach(() => {
  setCopyFailureReporter(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("makes UUIDs the review API accepts without crypto.randomUUID", () => {
  const ids = Array.from({ length: 50 }, () =>
    randomId({ getRandomValues: (array) => crypto.getRandomValues(array) }),
  );

  for (const id of ids) expect(z.uuid().safeParse(id).success).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
});

it("copies without navigator.clipboard", async () => {
  const report = vi.fn<() => void>();
  setCopyFailureReporter(report);
  document.execCommand = vi.fn<Document["execCommand"]>(() => true);

  expect(await copyText("abc123")).toBe(true);
  expect(document.execCommand).toHaveBeenCalledWith("copy");
  expect(report).not.toHaveBeenCalled();
});

it("tells the reader when nothing could be copied", async () => {
  const report = vi.fn<() => void>();
  setCopyFailureReporter(report);
  document.execCommand = vi.fn<Document["execCommand"]>(() => false);

  expect(await copyText("abc123")).toBe(false);
  expect(report).toHaveBeenCalledOnce();
});

it("leaves the report to a caller that tells the reader itself", async () => {
  const report = vi.fn<() => void>();
  setCopyFailureReporter(report);
  document.execCommand = vi.fn<Document["execCommand"]>(() => false);

  expect(await copyText("abc123", { silent: true })).toBe(false);
  expect(report).not.toHaveBeenCalled();
});
