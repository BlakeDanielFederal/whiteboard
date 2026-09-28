import type { ReviewCanvasDiagnostic } from "@dev.fast/review-protocol";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";

import {
  type Edit,
  applyEdit,
  documentSchema,
  editSchema,
} from "../../src/review-api/document";
import { blockComponents } from "./blocks";
import { mountReviewCanvas } from "./desktop-entry";
import { fixtureReviewBridge, settled } from "./fixture-review-bridge";
import { testApiDocumentData } from "./review-session-test-utils";

let canvas: ReturnType<typeof mountReviewCanvas> | undefined;

afterEach(async () => {
  await act(async () => canvas?.dispose());
  canvas = undefined;
  vi.restoreAllMocks();
});

it.each(["update", "replace"] as const)(
  "recovers a failed block through a %s snapshot without remounting its siblings",
  async (operation) => {
    const original = blockComponents.flow_diagram;
    vi.spyOn(blockComponents, "flow_diagram").mockImplementation((props) => {
      // Inject only the failure; loading, editing, boundaries and recovery are real.
      if (props.node.title === "Broken")
        throw new Error("injected flow failure");

      return original(props);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const api = {
      snapshot: testApiDocumentData(
        documentSchema.parse([
          {
            id: "broken",
            type: "flow_diagram",
            title: "Broken",
            nodes: [{ key: "a", label: "Recovered node" }],
            edges: [],
          },
          {
            id: "sibling",
            type: "section",
            title: "Healthy sibling",
            defaultCollapsed: false,
            children: [
              { id: "prose", type: "markdown", markdown: "Still here" },
            ],
          },
        ]),
      ).snapshot,
    };

    const bridge = fixtureReviewBridge(api);
    const request = bridge.request;
    let stream: ReadableStreamDefaultController<Uint8Array>;

    const emit = () =>
      stream.enqueue(
        new TextEncoder().encode(
          JSON.stringify([
            {
              value: {
                ...api.snapshot,
                activity: { workingCount: 0, expiresAt: null },
              },
            },
          ]) + "\n",
        ),
      );

    bridge.request = async (url, init) => {
      if (new URL(url).pathname.endsWith("/watch"))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              emit();
            },
          }),
        );

      return request(url, init);
    };

    const report = vi.fn<(diagnostic: ReviewCanvasDiagnostic) => void>();
    bridge.reportDiagnostic = report;
    const container = document.createElement("div");
    document.body.append(container);

    const content = () => ({
      kind: "api" as const,
      reviewId: api.snapshot.reviewId,
      bridge,
    });

    await act(async () => {
      canvas = mountReviewCanvas(container, content());
    });
    const alert = () => container.querySelector("[data-block-error]");
    expect(
      await settled(() =>
        alert()?.textContent?.includes("injected flow failure"),
      ),
    ).toBe(true);

    const errors = () =>
      report.mock.calls.filter(
        ([diagnostic]) => diagnostic.source === "render",
      );

    expect(errors()).toHaveLength(1);
    const sibling = container.querySelector("[data-review-node-id='sibling']")!;

    const toggle = sibling.querySelector<HTMLButtonElement>(
      "button[aria-expanded]",
    )!;

    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await act(async () => canvas!.update(content()));
    expect(alert()).not.toBeNull();
    expect(errors()).toHaveLength(1);

    let nextId = 0;

    const publish = async (edit: Edit) => {
      const document = structuredClone(api.snapshot.document);
      applyEdit(
        document,
        editSchema.parse(edit),
        (prefix) => `${prefix}-${++nextId}`,
      );
      api.snapshot = {
        ...api.snapshot,
        version: api.snapshot.version + 1,
        document,
      };
      await act(async () => emit());
    };

    // A new version that is still broken must settle at one report, not loop.
    await publish({
      type: "update",
      targetId: "prose",
      changes: { markdown: "Sibling edited" },
    });
    expect(await settled(() => errors().length === 2)).toBe(true);
    expect(alert()?.getAttribute("data-block-error")).toBe("flow_diagram");
    await act(async () => canvas!.update(content()));
    expect(errors()).toHaveLength(2);

    await publish(
      operation === "update"
        ? {
            type: "update",
            targetId: "broken",
            changes: { title: "Recovered flow" },
          }
        : {
            type: "replace",
            targetId: "broken",
            content: {
              type: "sequence",
              title: "Recovered sequence",
              actors: { a: "A", b: "B" },
              steps: [
                {
                  type: "step",
                  from: "a",
                  to: "b",
                  label: "Recovered call",
                  style: "call",
                  explanation: "A calls B.",
                },
              ],
            },
          },
    );

    const recovered = () =>
      container.querySelector("[data-review-node-id='broken']");

    expect(
      await settled(
        () =>
          !alert() &&
          !!recovered()?.querySelector(
            operation === "update" ? ".flow-node" : ".sequence-diagram-body",
          ),
      ),
    ).toBe(true);
    expect(recovered()?.textContent).toContain(
      operation === "update" ? "Recovered node" : "Recovered call",
    );
    expect(container.querySelector("[data-review-node-id='sibling']")).toBe(
      sibling,
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(errors()).toHaveLength(2);
  },
);
