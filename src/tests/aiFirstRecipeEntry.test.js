import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { recipes } from '$lib/data/import/paprikaRecipes.js'
import { seedRecipes } from '$lib/utils/seed/seedHelpers.js'

describe('AI-first Add Recipe entry', () => {
	it('routes the main Add Recipe links to AI and preserves manual entry', () => {
		const nav = readFileSync(join(process.cwd(), 'src/lib/components/ui/NavLinks.svelte'), 'utf8')
		const home = readFileSync(join(process.cwd(), 'src/routes/+page.svelte'), 'utf8')
		const ai = readFileSync(join(process.cwd(), 'src/routes/ai/+page.svelte'), 'utf8')

		expect(nav).toContain('href="/ai"')
		expect(nav).not.toContain('href="/recipe/new"')
		expect(home).toContain('href="/ai"')
		expect(ai).toContain('href="/recipe/new"')
		expect(ai).toContain('Manual entry')
	})

	it('provides five complete sample recipes', () => {
		expect(recipes).toHaveLength(5)
		for (const recipe of recipes) {
			expect(recipe.name).toBeTruthy()
			expect(recipe.description).toBeTruthy()
			expect(recipe.ingredients).toBeTruthy()
			expect(recipe.directions).toBeTruthy()
		}
	})

	it('skips sample recipes already owned by the target account', async () => {
		const prismaClient = {
			recipe: {
				findFirst: vi.fn().mockResolvedValue({ uid: 'existing' }),
				create: vi.fn()
			}
		}

		const result = await seedRecipes('test-user', prismaClient, { processPhotos: false })

		expect(result).toEqual({ created: 0, skipped: 5, failed: 0 })
		expect(prismaClient.recipe.create).not.toHaveBeenCalled()
	})
})
