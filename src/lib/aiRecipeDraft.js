import { defaultRecipe } from '$lib/utils/config.js'

function clean(value) {
	return typeof value === 'string' ? value.trim() : ''
}

function sourceFields(sourceNote) {
	const value = clean(sourceNote)
	if (/^https?:\/\//i.test(value)) {
		return { source: 'Cookbook AI', source_url: value, notes: '' }
	}
	return {
		source: 'Cookbook AI',
		source_url: '',
		notes: value ? `Source note: ${value}` : ''
	}
}

export function canSaveAiDraft(draft) {
	return Boolean(
		clean(draft?.title) &&
			Array.isArray(draft?.ingredients) &&
			draft.ingredients.some((item) => clean(item?.name)) &&
			Array.isArray(draft?.instructions) &&
			draft.instructions.some((item) => clean(item?.text))
	)
}

export function aiDraftToRecipe(draft, { sourceNote = '', isPublic = false } = {}) {
	if (!canSaveAiDraft(draft)) throw new Error('The AI draft is incomplete and cannot be saved.')

	const ingredients = draft.ingredients
		.map((item) => {
			const line = [clean(item?.quantity), clean(item?.unit), clean(item?.name)]
				.filter(Boolean)
				.join(' ')
			const note = clean(item?.note)
			return note ? `${line} (${note})` : line
		})
		.filter(Boolean)
		.join('\n')
	const directions = draft.instructions
		.map((item) => clean(item?.text))
		.filter(Boolean)
		.join('\n\n')

	return {
		...defaultRecipe,
		...sourceFields(sourceNote),
		name: clean(draft.title),
		description: clean(draft.description),
		servings: Number.isInteger(draft.servings) ? String(draft.servings) : clean(draft.servings),
		ingredients,
		directions,
		is_public: isPublic === true,
		saveImageUrl: false
	}
}
