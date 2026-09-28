/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// The native workbench owns layout, navigation, file search and text search.
// Review's canvas, workspace adapters and Agents-window defaults stay in its
// own entry point; the editor/extension-host services are shared.
import './editor.common.main.js';
import './editor.desktop.main.js';
import { reviewConfigurationDefaults } from './common/reviewConfigurationDefaults.js';
import '../workbench/browser/workbench.zenMode.contribution.js';
import '../workbench/browser/actions/layoutActions.js';
import '../workbench/browser/parts/editor/editorParts.js';
import '../workbench/browser/parts/paneCompositePartService.js';
import '../workbench/browser/parts/banner/bannerPart.js';
import '../workbench/browser/parts/statusbar/statusbarPart.js';
import '../workbench/browser/parts/titlebar/menubar.contribution.js';
import '../workbench/services/title/electron-browser/titleService.js';
import '../workbench/services/workspaces/electron-browser/workspaceEditingService.js';
import '../workbench/contrib/search/browser/search.contribution.js';
import '../workbench/contrib/searchEditor/browser/searchEditor.contribution.js';
import '../workbench/services/notebook/common/notebookDocumentService.js';
import '../workbench/services/aiRelatedInformation/common/aiRelatedInformationService.js';
import { Extensions as QuickAccessExtensions, IQuickAccessRegistry } from '../platform/quickinput/common/quickAccess.js';
import { CommandsQuickAccessProvider, ShowAllCommandsAction } from '../workbench/contrib/quickaccess/browser/commandsQuickAccess.js';
import { ChatAgentService, IChatAgentService } from '../workbench/contrib/chat/common/participants/chatAgents.js';
import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';
import { INotebookService } from '../workbench/contrib/notebook/common/notebookService.js';
import { NotebookService } from '../workbench/contrib/notebook/browser/services/notebookServiceImpl.js';
import { INotebookEditorService } from '../workbench/contrib/notebook/browser/services/notebookEditorService.js';
import { NotebookEditorWidgetService } from '../workbench/contrib/notebook/browser/services/notebookEditorServiceImpl.js';
import { INotebookEditorModelResolverService } from '../workbench/contrib/notebook/common/notebookEditorModelResolverService.js';
import { NotebookModelResolverServiceImpl } from '../workbench/contrib/notebook/common/notebookEditorModelResolverServiceImpl.js';
import { ISCMService } from '../workbench/contrib/scm/common/scm.js';
import { SCMService } from '../workbench/contrib/scm/common/scmService.js';
import { Registry } from '../platform/registry/common/platform.js';
import { Extensions, IConfigurationRegistry } from '../platform/configuration/common/configurationRegistry.js';
import { IStorageService, StorageScope, StorageTarget } from '../platform/storage/common/storage.js';
import { AccountsActivityActionViewItem } from '../workbench/browser/parts/globalCompositeBar.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../workbench/common/contributions.js';
import { IEditorResolverService } from '../workbench/services/editor/common/editorResolverService.js';
import { IConfigurationService } from '../platform/configuration/common/configuration.js';
import { Disposable } from '../base/common/lifecycle.js';
import { Extensions as ViewExtensions, IViewsRegistry, type IViewDescriptor, type ViewContainer } from '../workbench/common/views.js';
import { IContextKeyService } from '../platform/contextkey/common/contextkey.js';
import { VIEW_ID as EXPLORER_FOLDERS_VIEW_ID } from '../workbench/contrib/files/common/files.js';
import './browser/reviewDecorationColors.js';
import { NavigatorDecorationsService, NavigatorDiffEditorResolverService, NavigatorEmptySourceContentProvider, reviewFilesBase, SOURCE_MODE_CONTEXT, type SourceMode } from './services/navigatorDiffEditorResolverService.js';
import { localize, localize2 } from '../nls.js';
import { Action2, IMenuService, MenuId, registerAction2, type IMenu, type IMenuActionOptions, type IMenuCreateOptions, type MenuItemAction, type SubmenuItemAction } from '../platform/actions/common/actions.js';
import { MenuService } from '../platform/actions/common/menuService.js';
import { IQuickInputService } from '../platform/quickinput/common/quickInput.js';
import { IStatusbarService, StatusbarAlignment, type IStatusbarEntry } from '../workbench/services/statusbar/browser/statusbar.js';
import { TOGGLE_DIFF_IGNORE_TRIM_WHITESPACE, TOGGLE_DIFF_SIDE_BY_SIDE } from '../workbench/browser/parts/editor/diffEditorCommands.js';
import { ContextKeyExpr } from '../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../platform/instantiation/common/instantiation.js';
import type { ILocalizedString } from '../platform/action/common/action.js';
import { getCodeEditor, isCodeEditor, isDiffEditor } from '../editor/browser/editorBrowser.js';
import { IEditorService } from '../workbench/services/editor/common/editorService.js';
import { IDecorationsService } from '../workbench/services/decorations/common/decorations.js';
import { IDiffProviderFactoryService } from '../editor/browser/widget/diffEditor/diffProviderFactoryService.js';
import { NavigatorDiffProviderFactoryService } from './services/navigatorStructuralDiff.js';
import { URI } from '../base/common/uri.js';
import { Position } from '../editor/common/core/position.js';
import { ILanguageFeaturesService } from '../editor/common/services/languageFeatures.js';
import { SymbolNavigationAnchor } from '../editor/contrib/gotoSymbol/browser/goToCommands.js';
import { CommandsRegistry, ICommandService } from '../platform/commands/common/commands.js';
import { isEqual } from '../base/common/resources.js';

/** Set by the built-in review-files extension once its tree has listed the compared files. */
const REVIEW_FILES_ENABLED_CONTEXT = 'reviewFiles.enabled';

class NavigatorDefaults {
	constructor(@IStorageService storage: IStorageService) {
		// Use VS Code's own Hide Accounts preference; users can show it again.
		const key = AccountsActivityActionViewItem.ACCOUNTS_VISIBILITY_PREFERENCE_KEY;
		if (storage.get(key, StorageScope.PROFILE) === undefined) {
			storage.store(key, false, StorageScope.PROFILE, StorageTarget.USER);
		}
	}
}

registerWorkbenchContribution2('review.navigator.defaults', NavigatorDefaults, WorkbenchPhase.BlockStartup);

/**
 * The review-files tree replaces the Folders view once it has listed the
 * compared files. Folders comes back if the tree cannot list them, so the
 * window always shows the head source. Folders also keeps the Explorer
 * populated while the window restores its sidebar.
 */
class NavigatorReviewFiles extends Disposable {
	constructor(
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		if (reviewFilesBase(configuration) === undefined) {
			return;
		}
		const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		let replaced: { folders: IViewDescriptor; container: ViewContainer } | undefined;
		const update = () => {
			const folders = views.getView(EXPLORER_FOLDERS_VIEW_ID);
			const container = views.getViewContainer(EXPLORER_FOLDERS_VIEW_ID);
			if (contextKeys.getContextKeyValue<boolean>(REVIEW_FILES_ENABLED_CONTEXT) === true) {
				if (folders && container) {
					replaced = { folders, container };
					views.deregisterViews([folders], container);
				}
			} else if (replaced && !folders) {
				const { folders: restored, container: restoredContainer } = replaced;
				replaced = undefined;
				views.registerViews([restored], restoredContainer);
			}
		};
		this._register(views.onViewsRegistered(update));
		this._register(contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(new Set([REVIEW_FILES_ENABLED_CONTEXT]))) {
				update();
			}
		}));
	}
}

const sourceModes = [
	{ mode: 'diff', label: localize('review.sourceMode.diffLabel', "Diff"), description: localize('review.sourceMode.diffDescription', "Changes against the base, inline"), title: localize2('review.sourceMode.diff', "Show Diff") },
	{ mode: 'head', label: localize('review.sourceMode.headLabel', "Head"), description: localize('review.sourceMode.headDescription', "The file at the Review's head"), title: localize2('review.sourceMode.head', "Show Head") },
	{ mode: 'base', label: localize('review.sourceMode.baseLabel', "Base"), description: localize('review.sourceMode.baseDescription', "The file at the Review's base"), title: localize2('review.sourceMode.base', "Show Base") },
] satisfies { mode: SourceMode; label: string; description: string; title: ILocalizedString }[];
// The source window names a base only when it has one to compare with.
const hasBase = ContextKeyExpr.has('config.reviewFiles.base');
const sourceModeCategory = localize2('review.sourceMode.category', "Review Files");
const PICK_SOURCE_MODE_COMMAND = 'reviewFiles.pickSourceMode';

for (const { mode, title } of sourceModes) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: `reviewFiles.show.${mode}`,
				title,
				category: sourceModeCategory,
				f1: true,
				precondition: hasBase,
				toggled: ContextKeyExpr.equals(SOURCE_MODE_CONTEXT, mode),
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const resolver = accessor.get(IEditorResolverService);
			const editors = accessor.get(IEditorService);
			if (!(resolver instanceof NavigatorDiffEditorResolverService)) {
				return;
			}
			resolver.setMode(mode);

			// Reopen the active file in the new mode, at the same line.
			const pane = editors.activeEditorPane;
			const control = editors.activeTextEditorControl;
			const code = isDiffEditor(control) ? control.getModifiedEditor() : isCodeEditor(control) ? control : undefined;
			const resource = code?.getModel()?.uri;
			if (!pane || !resource) {
				return;
			}
			const position = code.getPosition();
			const source = resolver.sourceOf(resource);
			const selection = position && source === resource ? { startLineNumber: position.lineNumber, startColumn: position.column } : undefined;
			await editors.replaceEditors([{ editor: pane.input, replacement: { resource: source, options: { selection, pinned: true } } }], pane.group);
		}
	});
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PICK_SOURCE_MODE_COMMAND,
			title: localize2('review.sourceMode.pick', "Switch Between Diff, Head and Base"),
			category: sourceModeCategory,
			f1: true,
			precondition: hasBase,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const commands = accessor.get(ICommandService);
		const current = accessor.get(IContextKeyService).getContextKeyValue<SourceMode>(SOURCE_MODE_CONTEXT) ?? 'diff';
		const items = sourceModes.map(({ mode, label, description }) => ({ mode, label, description }));
		const picked = await quickInput.pick(items, {
			placeHolder: localize('review.sourceMode.placeholder', "Show the diff, the head file or the base file"),
			activeItem: items.find(item => item.mode === current),
		});
		if (picked) {
			await commands.executeCommand(`reviewFiles.show.${picked.mode}`);
		}
	}
});

/** Names the current mode in the status bar; clicking it opens the picker. */
class NavigatorSourceModeStatus extends Disposable {
	constructor(
		@IStatusbarService statusbar: IStatusbarService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		if (!reviewFilesBase(configuration)) {
			return;
		}
		const entry = (): IStatusbarEntry => {
			const mode = contextKeys.getContextKeyValue<SourceMode>(SOURCE_MODE_CONTEXT) ?? 'diff';
			const { label } = sourceModes.find(item => item.mode === mode) ?? sourceModes[0];
			return {
				name: localize('review.sourceMode.statusName', "Diff, Head or Base"),
				text: `${label} $(chevron-down)`,
				ariaLabel: localize('review.sourceMode.statusAria', "Showing {0}. Switch between the diff, the head file and the base file.", label),
				tooltip: localize('review.sourceMode.statusTooltip', "Switch between the diff, the head file and the base file"),
				command: PICK_SOURCE_MODE_COMMAND,
			};
		};
		const status = this._register(statusbar.addEntry(entry(), 'review.sourceMode', StatusbarAlignment.LEFT, 100));
		this._register(contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(new Set([SOURCE_MODE_CONTEXT]))) {
				status.update(entry());
			}
		}));
	}
}

/**
 * Title bar buttons the source window has no use for: diffr's diffs ignore the
 * whitespace option, and the window shows diffs inline. Only this window's
 * editor title bar leaves them out; nothing is stored in the shared profile.
 */
const HIDDEN_EDITOR_TITLE_COMMANDS = new Set([TOGGLE_DIFF_IGNORE_TRIM_WHITESPACE, TOGGLE_DIFF_SIDE_BY_SIDE]);

function withoutHiddenCommands(groups: [string, Array<MenuItemAction | SubmenuItemAction>][]): [string, Array<MenuItemAction | SubmenuItemAction>][] {
	return groups
		.map(([group, actions]): [string, Array<MenuItemAction | SubmenuItemAction>] => [group, actions.filter(action => !HIDDEN_EDITOR_TITLE_COMMANDS.has(action.id))])
		.filter(([, actions]) => actions.length > 0);
}

class NavigatorMenuService extends MenuService {
	override createMenu(id: MenuId, contextKeyService: IContextKeyService, options?: IMenuCreateOptions): IMenu {
		const menu = super.createMenu(id, contextKeyService, options);
		if (id !== MenuId.EditorTitle) {
			return menu;
		}
		return {
			onDidChange: menu.onDidChange,
			getActions: actionOptions => withoutHiddenCommands(menu.getActions(actionOptions)),
			dispose: () => menu.dispose(),
		};
	}

	override getMenuActions(id: MenuId, contextKeyService: IContextKeyService, options?: IMenuActionOptions): [string, Array<MenuItemAction | SubmenuItemAction>][] {
		const actions = super.getMenuActions(id, contextKeyService, options);
		return id === MenuId.EditorTitle ? withoutHiddenCommands(actions) : actions;
	}
}

registerWorkbenchContribution2('review.navigator.sourceModeStatus', NavigatorSourceModeStatus, WorkbenchPhase.AfterRestored);
registerSingleton(IMenuService, NavigatorMenuService, InstantiationType.Delayed);
registerWorkbenchContribution2('review.navigator.reviewFiles', NavigatorReviewFiles, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2('review.navigator.emptySource', NavigatorEmptySourceContentProvider, WorkbenchPhase.BlockStartup);
registerSingleton(IEditorResolverService, NavigatorDiffEditorResolverService, InstantiationType.Delayed);
registerSingleton(IDecorationsService, NavigatorDecorationsService, InstantiationType.Delayed);
registerSingleton(IDiffProviderFactoryService, NavigatorDiffProviderFactoryService, InstantiationType.Delayed);

CommandsRegistry.registerCommand('review.action.showReferencesInSource', async (accessor, resource: string, lineNumber: number, column: number) => {
	const editorService = accessor.get(IEditorService);
	const references = accessor.get(ILanguageFeaturesService).referenceProvider;
	const commandService = accessor.get(ICommandService);
	const uri = URI.parse(resource);
	const position = new Position(lineNumber, column);
	const pane = await editorService.openEditor({
		resource: uri,
		options: { selection: { startLineNumber: lineNumber, startColumn: column }, pinned: true },
	});
	const editor = getCodeEditor(pane?.getControl());
	if (!editor?.hasModel()) throw new Error('Could not open the source file for references.');
	const model = editor.getModel();
	if (!references.has(model)) {
		await new Promise<void>((resolve, reject) => {
			const listener = references.onDidChange(() => {
				if (references.has(model)) { listener.dispose(); clearTimeout(timeout); resolve(); }
			});
			const timeout = setTimeout(() => { listener.dispose(); reject(new Error('No reference provider became available for this file.')); }, 30_000);
			if (references.has(model)) { listener.dispose(); clearTimeout(timeout); resolve(); }
		});
	}
	// A diff or Base mode may show another file, already at the matching line.
	if (isEqual(model.uri, uri)) {
		editor.setPosition(position);
	}
	editor.focus();
	await commandService.executeCommand('editor.action.goToReferences', new SymbolNavigationAnchor(model, editor.getPosition()));
});

Registry.as<IQuickAccessRegistry>(QuickAccessExtensions.Quickaccess).registerQuickAccessProvider({
	ctor: CommandsQuickAccessProvider,
	prefix: CommandsQuickAccessProvider.PREFIX,
	contextKey: 'inCommandsPicker',
	helpEntries: [{ description: 'Show and Run Commands', commandId: ShowAllCommandsAction.ID }],
});
registerAction2(ShowAllCommandsAction);
registerSingleton(IChatAgentService, ChatAgentService, InstantiationType.Delayed);

registerSingleton(INotebookService, NotebookService, InstantiationType.Delayed);
registerSingleton(INotebookEditorService, NotebookEditorWidgetService, InstantiationType.Delayed);
registerSingleton(INotebookEditorModelResolverService, NotebookModelResolverServiceImpl, InstantiationType.Delayed);
registerSingleton(ISCMService, SCMService, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'telemetry.telemetryLevel': 'off',
		'chat.disableAIFeatures': true,
		'security.workspace.trust.enabled': false,
		'workbench.startupEditor': 'none',
		// Every source file opens as an inline diff against the base. Only
		// diffr's collapsed regions fold; a line diff shows the whole file.
		'diffEditor.renderSideBySide': false,
		'diffEditor.hideUnchangedRegions.enabled': true,
		// A base file lies outside the workspace folder, so its full path would
		// fill the breadcrumbs; the Files tree already shows where a file sits.
		'breadcrumbs.filePath': 'last',
		'window.autoDetectColorScheme': reviewConfigurationDefaults['window.autoDetectColorScheme'],
		'workbench.colorTheme': reviewConfigurationDefaults['workbench.colorTheme'],
		'workbench.preferredDarkColorTheme': reviewConfigurationDefaults['workbench.preferredDarkColorTheme'],
		'workbench.preferredLightColorTheme': reviewConfigurationDefaults['workbench.preferredLightColorTheme'],
	},
}]);

export { main } from '../workbench/electron-browser/desktop.main.js';
