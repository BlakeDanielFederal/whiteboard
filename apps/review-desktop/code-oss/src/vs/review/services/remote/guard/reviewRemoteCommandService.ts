/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from "../../../../base/common/event.js";
import { Disposable, DisposableMap, toDisposable } from "../../../../base/common/lifecycle.js";
import { revive } from "../../../../base/common/marshalling.js";
import type { Command } from "../../../../editor/common/languages.js";
import { CommandsRegistry, ICommandService } from "../../../../platform/commands/common/commands.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { ExtHostContext, type ExtHostCommandsShape, type MainThreadCommandsShape } from "../../../../workbench/api/common/extHost.protocol.js";
import type { IExtHostContext } from "../../../../workbench/services/extensions/common/extHostCustomers.js";
import { SerializableObjectWithBuffers } from "../../../../workbench/services/extensions/common/proxyIdentifier.js";
import { IReviewRemoteRefusals, type ReviewRemoteRefusals } from "./reviewRemoteGuard.js";

const LANGUAGE_API = "a `vscode.execute…` API command; it runs on this host's own providers (the scope's registry and models) and opens only this host's files";

export const REMOTE_WINDOW_COMMANDS: ReadonlyMap<string, string> = new Map([
	["_setContext", "`setContext`: the keys would change the laptop's menus, so the call succeeds and does nothing"],
	["_executeHoverProvider", LANGUAGE_API],
	["_executeDefinitionProvider", LANGUAGE_API],
	["_executeDeclarationProvider", LANGUAGE_API],
	["_executeTypeDefinitionProvider", LANGUAGE_API],
	["_executeImplementationProvider", LANGUAGE_API],
	["_executeReferenceProvider", LANGUAGE_API],
	["_executeDocumentHighlights", LANGUAGE_API],
]);

export function reviewRemoteRelayCommand(authority: string): string {
	return `_whiteboard.remoteCommand.${authority}`;
}

/** A command a host's UI carries, rewritten to run through its guard when the user clicks it. */
export function reviewRemoteRelay(authority: string, command: Command): Command {
	const relay = reviewRemoteRelayCommand(authority);
	return command.id === relay ? command : { ...command, id: relay, arguments: [command.id, ...(command.arguments ?? [])] };
}

export class ReviewRemoteCommandService extends Disposable implements ICommandService {
	declare readonly _serviceBrand: undefined;
	readonly onWillExecuteCommand = Event.None;
	readonly onDidExecuteCommand = Event.None;
	private readonly own = new Map<string, (...args: unknown[]) => unknown>();

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IReviewRemoteRefusals private readonly refusals: ReviewRemoteRefusals,
	) {
		super();
		this._register(CommandsRegistry.registerCommand(reviewRemoteRelayCommand(refusals.authority), async (_accessor, id: unknown, ...args: unknown[]) => {
			const own = typeof id === "string" && this.own.get(id);
			if (!own) throw this.refusals.refuse("running window commands", typeof id === "string" ? id : undefined);
			return own(...args);
		}));
	}

	addOwn(id: string, run: (...args: unknown[]) => unknown) {
		this.own.set(id, run);
		return toDisposable(() => {
			if (this.own.get(id) === run) this.own.delete(id);
		});
	}

	has(id: string): boolean {
		return this.own.has(id);
	}

	ids(): string[] {
		return [...this.own.keys(), ...[...REMOTE_WINDOW_COMMANDS.keys()].filter((id) => CommandsRegistry.getCommand(id))];
	}

	relay(command: Command): Command {
		return reviewRemoteRelay(this.refusals.authority, command);
	}

	async executeCommand<R = unknown>(id: string, ...args: unknown[]): Promise<R | undefined> {
		const own = this.own.get(id);
		if (own) return (await own(...args)) as R;
		if (!REMOTE_WINDOW_COMMANDS.has(id)) throw this.refusals.refuse("running window commands", id);
		if (id === "_setContext") return undefined;
		const command = CommandsRegistry.getCommand(id);
		if (!command) throw new Error(`command '${id}' not found`);
		return this.instantiationService.invokeFunction(command.handler, ...args) as R;
	}
}

export class ReviewRemoteCommands implements MainThreadCommandsShape {
	private readonly registrations = new DisposableMap<string>();
	private readonly proxy: ExtHostCommandsShape;
	private readonly commands: ReviewRemoteCommandService;

	constructor(
		context: IExtHostContext,
		@ICommandService commands: ICommandService,
		@IReviewRemoteRefusals private readonly refusals: ReviewRemoteRefusals,
	) {
		if (!(commands instanceof ReviewRemoteCommandService)) throw new Error("A remote host's scope has no guarded command service.");
		this.commands = commands;
		this.proxy = context.getProxy(ExtHostContext.ExtHostCommands);
	}

	$registerCommand(id: string): void {
		if (CommandsRegistry.getCommand(id) || this.commands.has(id)) throw this.refusals.refuse("replacing a window command", id);
		this.registrations.set(id, this.commands.addOwn(id, (...args) => this.proxy.$executeContributedCommand(id, ...args).then(revive)));
	}

	$unregisterCommand(id: string): void {
		this.registrations.deleteAndDispose(id);
	}

	$fireCommandActivationEvent(): void { }

	async $executeCommand(id: string, args: unknown[] | SerializableObjectWithBuffers<unknown[]>): Promise<unknown> {
		const values = args instanceof SerializableObjectWithBuffers ? args.value : args;
		return this.commands.executeCommand(id, ...values.map((value) => revive(value)));
	}

	async $getCommands(): Promise<string[]> {
		return this.commands.ids();
	}

	dispose(): void {
		this.registrations.dispose();
	}
}
