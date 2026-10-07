/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// Syntax highlighting for the browser diff library: the TextMate grammars and
// language definitions of Desktop's built-in language extensions, colored by
// the Whiteboard themes, through the same grammar factory and tokenizer the
// workbench uses. Grammars load from beside the bundle on first use.

import * as vscodeOniguruma from "vscode-oniguruma";
import * as vscodeTextmate from "vscode-textmate";
import type { IRawTheme } from "vscode-textmate";
import { createStyleSheet } from "../../base/browser/domStylesheets.js";
import { Color } from "../../base/common/color.js";
import { DisposableStore, type IDisposable } from "../../base/common/lifecycle.js";
import { constObservable } from "../../base/common/observableInternal/observables/constObservable.js";
import { URI } from "../../base/common/uri.js";
import { LazyTokenizationSupport, TokenizationRegistry, type ITokenizationSupport } from "../../editor/common/languages.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import type { LanguageConfiguration } from "../../editor/common/languages/languageConfiguration.js";
import { ILanguageConfigurationService } from "../../editor/common/languages/languageConfigurationRegistry.js";
import { ModesRegistry } from "../../editor/common/languages/modesRegistry.js";
import type { ILanguageExtensionPoint } from "../../editor/common/languages/language.js";
import { generateTokensCSSForColorMap } from "../../editor/common/languages/supports/tokenization.js";
import { StandardTokenType } from "../../editor/common/encodedTokenAttributes.js";
import type { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { TextMateTokenizationSupport } from "../../workbench/services/textMate/browser/tokenizationSupport/textMateTokenizationSupport.js";
import { TokenizationSupportWithLineLimit } from "../../workbench/services/textMate/browser/tokenizationSupport/tokenizationSupportWithLineLimit.js";
import { TMGrammarFactory } from "../../workbench/services/textMate/common/TMGrammarFactory.js";
import type { IValidGrammarDefinition, IValidTokenTypeMap } from "../../workbench/services/textMate/common/TMScopeRegistry.js";

interface ReviewWebLanguages {
	languages: Array<ILanguageExtensionPoint & { configuration?: LanguageConfiguration }>;
	grammars: Array<{
		path: string;
		language?: string;
		scopeName: string;
		embeddedLanguages?: Record<string, string>;
		tokenTypes?: Record<string, string>;
		injectTo?: string[];
		balancedBracketScopes?: string[];
		unbalancedBracketScopes?: string[];
	}>;
}

export interface ReviewWebTokenTheme {
	settings: IRawTheme["settings"];
	colorMap: string[];
}

/** Desktop's language extensions' languages and grammars, gathered by the bundle build. */
declare const __REVIEW_WEB_LANGUAGES__: ReviewWebLanguages;

// Desktop's default for `editor.maxTokenizationLineLength`.
const MAX_TOKENIZATION_LINE_LENGTH = 20_000;

const TOKEN_TYPES: Record<string, StandardTokenType> = {
	string: StandardTokenType.String,
	other: StandardTokenType.Other,
	comment: StandardTokenType.Comment,
	regex: StandardTokenType.RegEx,
};

export class ReviewWebTextMate {
	private readonly store = new DisposableStore();
	private readonly styleElement = createStyleSheet(undefined, undefined, this.store);
	private grammarFactory: Promise<TMGrammarFactory> | undefined;
	private theme: ReviewWebTokenTheme | undefined;

	constructor(private readonly instantiation: IInstantiationService) {
		const configurations = instantiation.invokeFunction(accessor => accessor.get(ILanguageConfigurationService));
		for (const { configuration, ...language } of __REVIEW_WEB_LANGUAGES__.languages) {
			this.store.add(ModesRegistry.registerLanguage(language));
			if (configuration) this.store.add(configurations.register(language.id, configuration));
		}
		for (const grammar of __REVIEW_WEB_LANGUAGES__.grammars) {
			const language = grammar.language;
			if (!language) continue;
			const lazy = this.store.add(new LazyTokenizationSupport(() => this.createTokenizationSupport(language)));
			this.store.add(TokenizationRegistry.registerFactory(language, lazy));
		}
	}

	/** Colors tokens with `theme`; call after the editor theme changes, which resets the color map. */
	setTheme(theme: ReviewWebTokenTheme): void {
		this.theme = theme;
		const colorMap = [null!, ...theme.colorMap.slice(1).map(color => Color.Format.CSS.parseHex(color)!)];
		this.styleElement.textContent = generateTokensCSSForColorMap(colorMap);
		TokenizationRegistry.setColorMap(colorMap);
		void this.grammarFactory?.then(factory => factory.setTheme({ settings: theme.settings }, theme.colorMap));
	}

	private getGrammarFactory(): Promise<TMGrammarFactory> {
		this.grammarFactory ??= (async () => {
			const wasm = await fetch(new URL("./onig.wasm", import.meta.url));
			await vscodeOniguruma.loadWASM(await wasm.arrayBuffer());
			const languages = this.instantiation.invokeFunction(accessor => accessor.get(ILanguageService));
			const factory = this.store.add(new TMGrammarFactory({
				logTrace: () => { },
				logError: (message, error) => console.error(message, error),
				readFile: async resource => {
					const response = await fetch(resource.toString(true));
					if (!response.ok) throw new Error(`Could not load grammar ${resource.path} (${response.status}).`);
					return response.text();
				},
			}, __REVIEW_WEB_LANGUAGES__.grammars.map(grammar => grammarDefinition(grammar, languages)), vscodeTextmate, Promise.resolve({
				createOnigScanner: sources => vscodeOniguruma.createOnigScanner(sources),
				createOnigString: text => vscodeOniguruma.createOnigString(text),
			})));
			if (this.theme) factory.setTheme({ settings: this.theme.settings }, this.theme.colorMap);
			return factory;
		})();
		return this.grammarFactory;
	}

	private async createTokenizationSupport(languageId: string): Promise<(ITokenizationSupport & IDisposable) | null> {
		const factory = await this.getGrammarFactory();
		if (!factory.has(languageId)) return null;
		const languages = this.instantiation.invokeFunction(accessor => accessor.get(ILanguageService));
		const encodedLanguageId = languages.languageIdCodec.encodeLanguageId(languageId);
		const { grammar, initialState, containsEmbeddedLanguages } = await factory.createGrammar(languageId, encodedLanguageId);
		if (!grammar) return null;
		const store = new DisposableStore();
		// Review sources are short-lived and read-only: tokenize on the main thread.
		const tokenization = store.add(new TextMateTokenizationSupport(grammar, initialState, containsEmbeddedLanguages, undefined, () => false, () => { }, false));
		return new TokenizationSupportWithLineLimit(encodedLanguageId, tokenization, store, constObservable(MAX_TOKENIZATION_LINE_LENGTH));
	}

	dispose(): void {
		this.store.dispose();
	}
}

/** A grammar contribution as the workbench validates it. */
function grammarDefinition(grammar: ReviewWebLanguages["grammars"][number], languages: ILanguageService): IValidGrammarDefinition {
	const embeddedLanguages = Object.create(null);
	for (const [scope, language] of Object.entries(grammar.embeddedLanguages ?? {})) {
		if (languages.isRegisteredLanguageId(language)) embeddedLanguages[scope] = languages.languageIdCodec.encodeLanguageId(language);
	}
	const tokenTypes: IValidTokenTypeMap = Object.create(null);
	for (const [scope, type] of Object.entries(grammar.tokenTypes ?? {})) {
		if (type in TOKEN_TYPES) tokenTypes[scope] = TOKEN_TYPES[type];
	}
	return {
		location: URI.parse(new URL(`./${grammar.path}`, import.meta.url).href),
		language: grammar.language && languages.isRegisteredLanguageId(grammar.language) ? grammar.language : undefined,
		scopeName: grammar.scopeName,
		embeddedLanguages,
		tokenTypes,
		injectTo: grammar.injectTo,
		balancedBracketSelectors: grammar.balancedBracketScopes ?? ["*"],
		unbalancedBracketSelectors: grammar.unbalancedBracketScopes ?? [],
	};
}
