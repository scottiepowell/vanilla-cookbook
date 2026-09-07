import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { aiDraftToRecipe, canSaveAiDraft } from '$lib/aiRecipeDraft.js'

const draft = {
	title: 'Skillet Chickpea Pasta',
	description: 'A weeknight pasta.',
	servings: 4,
	ingredients: [
		{ quantity: '12', unit: 'oz', name: 'rigatoni', note: 'cooked al dente' },
		{ quantity: '1', unit: 'can', name: 'chickpeas', note: null }
	],
	instructions: [{ text: 'Cook the rigatoni.' }, { text: 'Fold in the chickpeas.' }]
}

describe('AI recipe draft saving', () => {
	it('maps a complete AI draft to the canonical recipe create payload', () => {
		const recipe = aiDraftToRecipe(draft, {
			sourceNote: 'https://example.com/inspiration',
			isPublic: true
		})

		expect(recipe).toMatchObject({
			name: 'Skillet Chickpea Pasta',
			description: 'A weeknight pasta.',
			servings: '4',
			source: 'Cookbook AI',
			source_url: 'https://example.com/inspiration',
			ingredients: '12 oz rigatoni (cooked al dente)\n1 can chickpeas',
			directions: 'Cook the rigatoni.\n\nFold in the chickpeas.',
			is_public: true,
			saveImageUrl: false
		})
	})

	it('keeps a non-URL source note out of the URL field', () => {
		const recipe = aiDraftToRecipe(draft, { sourceNote: 'Family weeknight idea' })

		expect(recipe.source_url).toBe('')
		expect(recipe.notes).toBe('Source note: Family weeknight idea')
		expect(recipe.is_public).toBe(false)
	})

	it('rejects incomplete drafts', () => {
		expect(canSaveAiDraft({ title: 'Incomplete', ingredients: [], instructions: [] })).toBe(false)
		expect(() =>
			aiDraftToRecipe({ title: 'Incomplete', ingredients: [], instructions: [] })
		).toThrow('incomplete')
	})

	it('renders the guarded canonical save control in the AI page', () => {
		const page = readFileSync(join(process.cwd(), 'src/routes/ai/+page.svelte'), 'utf8')
		const server = readFileSync(join(process.cwd(), 'src/routes/ai/+page.server.js'), 'utf8')

		expect(page).toContain('Save to Cookbook')
		expect(page).toContain('createRecipe(formData)')
		expect(page).toContain('disabled={saving || loading || !canSaveAiDraft(draft)}')
		expect(server).toContain('userPublicRecipes: locals.user.publicRecipes ?? false')
	})
})
