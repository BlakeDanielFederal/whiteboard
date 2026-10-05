/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IMarkdownString } from "../../../../base/common/htmlContent.js";
import { parse } from "../../../../base/common/marshalling.js";
import { matchesScheme, Schemas } from "../../../../base/common/network.js";
import { URI } from "../../../../base/common/uri.js";
import type { LanguageFeatureRegistry } from "../../../../editor/common/languageFeatureRegistry.js";
import type { Mutable } from "../../../../base/common/types.js";
import type { Command, CompletionItem, ILink, InlayHint, InlineCompletion, InlineCompletions, ProviderResult } from "../../../../editor/common/languages.js";
import type { ILanguageFeaturesService } from "../../../../editor/common/services/languageFeatures.js";
import { reviewRemoteRelay } from "./reviewRemoteCommandService.js";
import { override } from "./reviewRemoteGuard.js";

/** `CommandOpener`'s reading of a `command:` link's arguments. */
function linkArguments(query: string): unknown[] {
	let args: unknown = [];
	try {
		args = parse(decodeURIComponent(query));
	} catch {
		try {
			args = parse(query);
		} catch { }
	}
	return Array.isArray(args) ? args : [args];
}

/** A provider's result, once it arrives, with `fix` applied to it in place. */
async function then<R>(result: ProviderResult<R>, fix: (value: R) => void) {
	const value = await result;
	if (value) fix(value);
	return value;
}

/**
 * A Source window host's language features: every command in its results runs
 * through the host's relay, and its markdown is untrusted.
 */
export function reviewRemoteLanguageFeatures(base: ILanguageFeaturesService, authority: string): ILanguageFeaturesService {
	const relay = (command: Command) => reviewRemoteRelay(authority, command);
	const relayIn = (item: { command?: Command }) => {
		if (item.command) item.command = relay(item.command);
	};
	const untrusted = <T extends string | IMarkdownString | undefined>(value: T): T => (typeof value === "object" ? ({ ...(value as IMarkdownString), isTrusted: false } as T) : value);
	const documented = (item: { documentation?: string | IMarkdownString }) => {
		item.documentation = untrusted(item.documentation);
	};
	const hint = (value: InlayHint) => {
		value.tooltip = untrusted(value.tooltip);
		if (typeof value.label !== "string") for (const part of value.label) {
			relayIn(part);
			part.tooltip = untrusted(part.tooltip);
		}
	};
	const link = (value: ILink) => {
		if (value.url && matchesScheme(value.url, Schemas.command)) {
			const uri = typeof value.url === "string" ? URI.parse(value.url) : value.url;
			const { id, arguments: args } = relay({ id: uri.path, title: "", arguments: linkArguments(uri.query) });
			value.url = uri.with({ path: id, query: encodeURIComponent(JSON.stringify(args)) });
		}
	};
	const completion = (item: CompletionItem) => {
		relayIn(item);
		documented(item);
	};
	const inline = (item: Mutable<InlineCompletion>) => {
		for (const key of ["command", "shownCommand", "gutterMenuLinkAction"] as const) {
			const command = item[key];
			if (command) item[key] = relay(command);
		}
		if (item.warning) item.warning = { ...item.warning, message: untrusted(item.warning.message) };
	};
	const wrap = <T extends object>(registry: LanguageFeatureRegistry<T>, members: (provider: T) => Partial<T>) =>
		override(registry, { register: (selector, provider) => registry.register(selector, override(provider, members(provider))) });

	return override(base, {
		codeActionProvider: wrap(base.codeActionProvider, (provider) => ({
			provideCodeActions: (...args) => then(provider.provideCodeActions(...args), (list) => list.actions.forEach(relayIn)),
			resolveCodeAction: provider.resolveCodeAction && ((...args) => then(provider.resolveCodeAction!(...args), relayIn)),
			documentation: provider.documentation?.map((entry) => ({ ...entry, command: relay(entry.command) })),
		})),
		codeLensProvider: wrap(base.codeLensProvider, (provider) => ({
			provideCodeLenses: (...args) => then(provider.provideCodeLenses(...args), (list) => list.lenses.forEach(relayIn)),
			resolveCodeLens: provider.resolveCodeLens && ((...args) => then(provider.resolveCodeLens!(...args), relayIn)),
		})),
		completionProvider: wrap(base.completionProvider, (provider) => ({
			provideCompletionItems: (...args) => then(provider.provideCompletionItems(...args), (list) => list.suggestions.forEach(completion)),
			resolveCompletionItem: provider.resolveCompletionItem && ((...args) => then(provider.resolveCompletionItem!(...args), completion)),
		})),
		inlineCompletionsProvider: wrap(base.inlineCompletionsProvider, (provider) => ({
			provideInlineCompletions: (...args) => then(provider.provideInlineCompletions(...args), (list: Mutable<InlineCompletions>) => {
				list.items.forEach(inline);
				if (list.commands) list.commands = list.commands.map((entry) => ({ ...entry, command: relay(entry.command) }));
			}),
		})),
		inlayHintsProvider: wrap(base.inlayHintsProvider, (provider) => ({
			provideInlayHints: (...args) => then(provider.provideInlayHints(...args), (list) => list.hints.forEach(hint)),
			resolveInlayHint: provider.resolveInlayHint && ((...args) => then(provider.resolveInlayHint!(...args), hint)),
		})),
		linkProvider: wrap(base.linkProvider, (provider) => ({
			provideLinks: (...args) => then(provider.provideLinks(...args), (list) => list.links.forEach(link)),
			resolveLink: provider.resolveLink && ((...args) => then(provider.resolveLink!(...args), link)),
		})),
		hoverProvider: wrap(base.hoverProvider, (provider) => ({
			provideHover: (...args) => then(provider.provideHover(...args), (hover) => {
				hover.contents = hover.contents.map(untrusted);
			}),
		})),
		signatureHelpProvider: wrap(base.signatureHelpProvider, (provider) => ({
			provideSignatureHelp: (...args) => then(provider.provideSignatureHelp(...args), (result) => {
				for (const signature of result.value.signatures) {
					documented(signature);
					signature.parameters.forEach(documented);
				}
			}),
		})),
	});
}
