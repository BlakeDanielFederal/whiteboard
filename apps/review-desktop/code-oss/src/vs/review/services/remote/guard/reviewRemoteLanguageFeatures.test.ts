import assert from "node:assert/strict";
import test from "node:test";
import { CancellationToken } from "../../../../base/common/cancellation.js";
import { Disposable, DisposableStore } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import type { IMarkdownString } from "../../../../base/common/htmlContent.js";
import type { CodeAction, CodeActionProvider, CodeLensProvider, Command, CompletionItemProvider, HoverProvider, ILink, InlayHintLabelPart, InlayHintsProvider, InlineCompletionsProvider, LinkProvider, SignatureHelpProvider } from "../../../../editor/common/languages.js";
import type { ILanguageFeaturesService } from "../../../../editor/common/services/languageFeatures.js";
import { CommandsRegistry, ICommandService } from "../../../../platform/commands/common/commands.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { InstantiationService } from "../../../../platform/instantiation/common/instantiationService.js";
import { ServiceCollection } from "../../../../platform/instantiation/common/serviceCollection.js";
import type { ILogService } from "../../../../platform/log/common/log.js";
import type { IExtHostContext } from "../../../../workbench/services/extensions/common/extHostCustomers.js";
import { ReviewRemoteCommands, ReviewRemoteCommandService } from "./reviewRemoteCommandService.js";
import { IReviewRemoteRefusals, ReviewRemoteRefusals } from "./reviewRemoteGuard.js";
import { reviewRemoteLanguageFeatures } from "./reviewRemoteLanguageFeatures.js";

const A = "whiteboard+aaaa-1111";
const refused = /^Error: Not available for an extension on wb-test-a: running window commands/;
const KINDS = ["codeActionProvider", "codeLensProvider", "completionProvider", "inlineCompletionsProvider", "inlayHintsProvider", "linkProvider", "hoverProvider", "signatureHelpProvider"] as const;

/** A Source window with a remote host whose extensions registered `_typescript.applyCodeAction`. */
function sourceWindow(t: { after(fn: () => void): void }) {
	const store = new DisposableStore();
	t.after(() => store.dispose());
	const ran: string[] = [];
	for (const id of ["workbench.action.openSettings", "vscode.openFolder", "_workbench.open", "_executeHoverProvider"]) {
		store.add(CommandsRegistry.registerCommand(id, () => ran.push(id)));
	}
	const warnings: string[] = [];
	const refusals = new ReviewRemoteRefusals(A, () => "wb-test-a", { warn: (message: string) => warnings.push(message) } as unknown as ILogService);
	const scope = store.add(new InstantiationService(new ServiceCollection([IReviewRemoteRefusals, refusals], [ICommandService, new SyncDescriptor(ReviewRemoteCommandService)]), true));
	const executed: unknown[][] = [];
	const context = { getProxy: () => ({ $executeContributedCommand: async (...args: unknown[]) => executed.push(args) && "applied" }) } as unknown as IExtHostContext;
	store.add(scope.createInstance(ReviewRemoteCommands, context)).$registerCommand("_typescript.applyCodeAction");
	store.add(scope.invokeFunction((accessor) => accessor.get(ICommandService)) as ReviewRemoteCommandService);

	const registered = new Map<string, object>();
	const base = Object.fromEntries(KINDS.map((kind) => [kind, { register: (_selector: unknown, provider: object) => (registered.set(kind, provider), Disposable.None) }]));
	const features = reviewRemoteLanguageFeatures(base as unknown as ILanguageFeaturesService, A);
	/** What the window's command service does with a command in a provider's result. */
	const click = async (command: Command | undefined) => CommandsRegistry.getCommand(command!.id)!.handler({} as never, ...(command!.arguments ?? []));
	return { features, registered, click, ran, warnings, executed };
}

const model = {} as never;
const token = CancellationToken.None;
const action = (id: string): CodeAction => ({ title: "Fix", command: { id, title: "Fix", arguments: [{ file: "/home/dev/proj/f.ts" }] } });

test("a code action's command from the remote runs through its relay, and its id stays out of the window", async (t) => {
	const { features, registered, click, executed } = sourceWindow(t);
	features.codeActionProvider.register("typescript", { provideCodeActions: () => ({ actions: [action("_typescript.applyCodeAction")], dispose() { } }) });
	const provider = registered.get("codeActionProvider") as CodeActionProvider;
	const [fix] = (await provider.provideCodeActions(model, {} as never, {} as never, token))!.actions;

	assert.equal(await click(fix.command), "applied");
	assert.deepEqual(executed, [["_typescript.applyCodeAction", { file: "/home/dev/proj/f.ts" }]]);
	assert.equal(CommandsRegistry.getCommand("_typescript.applyCodeAction"), undefined);
});

test("a window command in a code action, a code lens, a completion, an inlay hint or a command: link, provided or resolved, is refused", async (t) => {
	const { features, registered, click, ran, warnings } = sourceWindow(t);
	const ids = ["workbench.action.openSettings", "vscode.openFolder", "_workbench.open", "_executeHoverProvider"];
	const lens = (id: string) => ({ range: {} as never, command: { id, title: id } });
	const link = (id: string): ILink => ({ range: {} as never, url: `command:${id}?${encodeURIComponent(JSON.stringify([URI.file("/")]))}` });
	features.codeActionProvider.register("*", { provideCodeActions: () => ({ actions: ids.map(action), dispose() { } }), resolveCodeAction: (value) => value });
	features.codeLensProvider.register("*", { provideCodeLenses: () => ({ lenses: ids.map(lens) }), resolveCodeLens: () => lens("workbench.action.openSettings") });
	features.completionProvider.register("*", { _debugDisplayName: "remote", provideCompletionItems: () => ({ suggestions: ids.map((id) => ({ label: id, insertText: "", kind: 0, range: {} as never, command: { id, title: id } })) }), resolveCompletionItem: (item) => ({ ...item, command: { id: "vscode.openFolder", title: "" } }) });
	features.inlayHintsProvider.register("*", { provideInlayHints: () => ({ hints: [{ label: ids.map((id) => ({ label: id, command: { id, title: id } })), position: {} as never }], dispose() { } }), resolveInlayHint: () => ({ label: [{ label: "x", command: { id: "_workbench.open", title: "" } }], position: {} as never }) });
	features.linkProvider.register("*", { provideLinks: () => ({ links: ids.map(link) }), resolveLink: (value) => value });

	const actions = (await (registered.get("codeActionProvider") as CodeActionProvider).provideCodeActions(model, {} as never, {} as never, token))!.actions;
	const resolved = await (registered.get("codeActionProvider") as CodeActionProvider).resolveCodeAction!(actions[0], token);
	const lenses = (await (registered.get("codeLensProvider") as CodeLensProvider).provideCodeLenses(model, token))!.lenses;
	const items = (await (registered.get("completionProvider") as CompletionItemProvider).provideCompletionItems(model, {} as never, {} as never, token))!.suggestions;
	const [hint] = (await (registered.get("inlayHintsProvider") as InlayHintsProvider).provideInlayHints(model, {} as never, token))!.hints;
	const resolvedLens = await (registered.get("codeLensProvider") as CodeLensProvider).resolveCodeLens!(model, lenses[0], token);
	const resolvedItem = await (registered.get("completionProvider") as CompletionItemProvider).resolveCompletionItem!(items[0], token);
	const resolvedHint = await (registered.get("inlayHintsProvider") as InlayHintsProvider).resolveInlayHint!(hint, token);
	const links = (await (registered.get("linkProvider") as LinkProvider).provideLinks(model, token))!.links;
	const linkCommands = links.map(({ url }) => {
		const uri = url as URI;
		return { id: uri.path, title: "", arguments: JSON.parse(decodeURIComponent(uri.query)) };
	});

	const parts = [...(hint.label as { command?: Command }[]), ...(resolvedHint!.label as { command?: Command }[])];
	const commands = [...actions, resolved!, ...lenses, resolvedLens!, ...items, resolvedItem!, ...parts].map((item) => item.command).concat(linkCommands);
	assert.equal(commands.length, 24);
	assert.deepEqual(resolved!.command!.arguments![0], "workbench.action.openSettings");
	for (const command of commands) await assert.rejects(click(command), refused, JSON.stringify(command));
	assert.deepEqual(linkCommands[1].arguments, ["vscode.openFolder", { $mid: 1, path: "/", scheme: "file" }]);
	assert.deepEqual(ran, []);
	assert.deepEqual(warnings, [`[Remote guard] ${A}: refused running window commands`]);
});

test("an inline completion's commands run through the relay: a host-registered one runs, a window one, even shown with no click, is refused", async (t) => {
	const { features, registered, click, ran, executed } = sourceWindow(t);
	const command = (id: string) => ({ id, title: id });
	features.inlineCompletionsProvider.register("*", {
		provideInlineCompletions: () => ({
			items: [{ insertText: "x", command: command("_typescript.applyCodeAction"), shownCommand: command("workbench.action.terminal.new"), gutterMenuLinkAction: command("vscode.openFolder"), warning: { message: { value: "[x](command:workbench.action.terminal.new)", isTrusted: true } } }],
			commands: [{ command: command("workbench.action.openSettings") }],
		}),
		disposeInlineCompletions() { },
	});
	const list = (await (registered.get("inlineCompletionsProvider") as InlineCompletionsProvider).provideInlineCompletions(model, {} as never, {} as never, token))!;
	const [item] = list.items;

	assert.equal(await click(item.command), "applied");
	assert.deepEqual(executed, [["_typescript.applyCodeAction"]]);
	for (const refusedCommand of [item.shownCommand, item.gutterMenuLinkAction, list.commands![0].command]) await assert.rejects(click(refusedCommand), refused);
	assert.equal((item.warning!.message as IMarkdownString).isTrusted, false);
	assert.deepEqual(ran, []);
});

test("the host's hovers, completion documentation, signature help and inlay tooltips reach the window untrusted, their text unchanged", async (t) => {
	const { features, registered } = sourceWindow(t);
	const value = "[run](command:workbench.action.terminal.new) and [docs](https://example.com/)";
	const trusted = (): IMarkdownString => ({ value, isTrusted: true });
	const scoped = (): IMarkdownString => ({ value, isTrusted: { enabledCommands: ["workbench.action.terminal.new"] } });
	features.hoverProvider.register("*", { provideHover: () => ({ contents: [trusted(), scoped()] }) });
	features.completionProvider.register("*", {
		_debugDisplayName: "remote",
		provideCompletionItems: () => ({ suggestions: [{ label: "a", insertText: "a", kind: 0, range: {} as never, documentation: trusted() }] }),
		resolveCompletionItem: (item) => ({ ...item, documentation: scoped() }),
	});
	features.signatureHelpProvider.register("*", {
		signatureHelpTriggerCharacters: [],
		signatureHelpRetriggerCharacters: [],
		provideSignatureHelp: () => ({ value: { signatures: [{ label: "f(a)", documentation: trusted(), parameters: [{ label: "a", documentation: scoped() }] }], activeSignature: 0, activeParameter: 0 }, dispose() { } }),
	});
	features.inlayHintsProvider.register("*", { provideInlayHints: () => ({ hints: [{ label: [{ label: "a", tooltip: trusted() }], tooltip: scoped(), position: {} as never }], dispose() { } }) });

	const hover = (await (registered.get("hoverProvider") as HoverProvider).provideHover(model, {} as never, token))!;
	const completions = registered.get("completionProvider") as CompletionItemProvider;
	const [item] = (await completions.provideCompletionItems(model, {} as never, {} as never, token))!.suggestions;
	const resolved = (await completions.resolveCompletionItem!(item, token))!;
	const { signatures: [signature] } = (await (registered.get("signatureHelpProvider") as SignatureHelpProvider).provideSignatureHelp(model, {} as never, token, {} as never))!.value;
	const [hint] = (await (registered.get("inlayHintsProvider") as InlayHintsProvider).provideInlayHints(model, {} as never, token))!.hints;

	const markdown = [...hover.contents, item.documentation, resolved.documentation, signature.documentation, signature.parameters[0].documentation, hint.tooltip, (hint.label as InlayHintLabelPart[])[0].tooltip] as IMarkdownString[];
	assert.equal(markdown.length, 8);
	for (const entry of markdown) assert.deepEqual(entry, { value, isTrusted: false });
});
