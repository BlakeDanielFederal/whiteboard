import assert from 'node:assert/strict';
import test from 'node:test';
import type { URI } from '../../base/common/uri.js';
import type { ILanguageService } from '../../editor/common/languages/language.js';
import type { ITextModel } from '../../editor/common/model.js';
import type { IModelService } from '../../editor/common/services/model.js';
import { apiSourceUri } from '../common/reviewSourceView.js';
import { reviewApiSourceContentProvider, type ReviewSourceRead } from '../services/reviewApiSourceContent.js';
import { ReviewWebTextModelService } from './reviewWebTextModelService.js';

function fakeModels() {
	const models = new Map<string, ITextModel>();
	const service = {
		getModel: (resource: URI) => models.get(resource.toString()) ?? null,
		createModel: (text: string, language: { languageId: string }, resource: URI) => {
			const model = { uri: resource, getValue: () => text, getLanguageId: () => language.languageId } as unknown as ITextModel;
			models.set(resource.toString(), model);
			return model;
		},
	} as unknown as IModelService;
	const languages = {
		createById: (languageId: string) => ({ languageId }),
		createByFilepathOrFirstLine: () => ({ languageId: 'typescript' }),
	} as unknown as ILanguageService;
	return { service, languages };
}

const view = { reviewId: 'r1', version: 3 };

function serviceReading(answer: (query: Record<string, string | number | undefined>) => unknown) {
	const requests: Array<Record<string, string | number | undefined>> = [];
	const read: ReviewSourceRead = async <T>(_reviewId: string, route: string, query: Record<string, string | number | undefined>) => {
		assert.equal(route, '/file');
		requests.push(query);
		return answer(query) as T;
	};
	const { service, languages } = fakeModels();
	const textModels = new ReviewWebTextModelService(service);
	textModels.registerTextModelContentProvider('review-api-source', reviewApiSourceContentProvider(service, languages, read));
	return { textModels, requests };
}

test('reads a review source at its side and pins', async () => {
	const { textModels, requests } = serviceReading(() => ({ text: 'export const one = 1;\n' }));
	const reference = await textModels.createModelReference(apiSourceUri({ view, side: 'head', file: 'src/one.ts' }));
	assert.equal(reference.object.textEditorModel.getValue(), 'export const one = 1;\n');
	assert.equal(reference.object.isReadonly(), true);
	assert.equal(requests[0].side, 'head');
	assert.equal(requests[0].file, 'src/one.ts');
	assert.equal(requests[0].version, 3);
});

test('a binary file reads as a notice, not its bytes', async () => {
	const { textModels } = serviceReading(() => ({ binary: true }));
	const reference = await textModels.createModelReference(apiSourceUri({ view, side: 'base', file: 'logo.png' }));
	assert.equal(reference.object.textEditorModel.getValue(), 'Binary file cannot be displayed as text.');
	assert.equal(reference.object.getLanguageId(), 'plaintext');
});

test('an empty side reads nothing from the server', async () => {
	const { textModels, requests } = serviceReading(() => assert.fail('an empty side must not be fetched'));
	const reference = await textModels.createModelReference(apiSourceUri({ view, side: 'base', file: 'added.ts' }, true));
	assert.equal(reference.object.textEditorModel.getValue(), '');
	assert.equal(requests.length, 0);
});

test('a provider that serves only its own resources passes the rest to earlier ones, until it is gone', async () => {
	const { textModels, requests } = serviceReading(() => ({ text: 'from the source' }));
	const { service, languages } = fakeModels();
	const snapshot = apiSourceUri({ view, side: 'head', file: 'structural.ts' });
	const structural = textModels.registerTextModelContentProvider('review-api-source', {
		provideTextContent: async uri => uri.toString() === snapshot.toString() ? service.createModel('from the snapshot', languages.createById('typescript'), uri) : null,
	});
	const own = await textModels.createModelReference(snapshot);
	const other = await textModels.createModelReference(apiSourceUri({ view, side: 'head', file: 'plain.ts' }));
	assert.equal(own.object.textEditorModel.getValue(), 'from the snapshot');
	assert.equal(other.object.textEditorModel.getValue(), 'from the source');
	structural.dispose();
	const later = await textModels.createModelReference(apiSourceUri({ view, side: 'base', file: 'plain.ts' }));
	assert.equal(later.object.textEditorModel.getValue(), 'from the source');
	assert.equal(requests.length, 2);
});

test('concurrent requests for one file share one read', async () => {
	const { textModels, requests } = serviceReading(() => ({ text: 'shared' }));
	const resource = apiSourceUri({ view, side: 'head', file: 'shared.ts' });
	const [first, second] = await Promise.all([textModels.createModelReference(resource), textModels.createModelReference(resource)]);
	assert.equal(first.object.textEditorModel, second.object.textEditorModel);
	assert.equal(requests.length, 1);
});
