import { describe, expect, it, vi, beforeEach } from 'vitest'
vi.mock('$env/dynamic/private', () => ({
	env: {
		AI_SIDECAR_ENABLED: 'true',
		AI_SIDECAR_URL: 'http://ai:8000',
		AI_SIDECAR_OPERATOR_TOKEN: 'test-token'
	}
}))
vi.mock('$lib/server/prisma', () => ({ prisma: { recipe: { findMany: vi.fn() } } }))
import { prisma } from '$lib/server/prisma'
import { POST } from '../routes/api/recipe/discover/+server.js'
const request = (body) =>
	new Request('http://localhost/api/recipe/discover', {
		method: 'POST',
		body: JSON.stringify(body)
	})
let sequence = 0
const locals = () => ({ user: { userId: `test-${++sequence}` } })
beforeEach(() =>
	prisma.recipe.findMany.mockResolvedValue([
		{ uid: 'saved', name: 'Saved salad', ingredients: 'carrot lettuce onion' }
	])
)
describe('discovery route', () => {
	it('requires authentication before database access', async () => {
		prisma.recipe.findMany.mockClear()
		await expect(
			POST({ request: request({ ingredients: 'carrots' }), locals: {}, fetch: vi.fn() })
		).rejects.toMatchObject({ status: 401 })
		expect(prisma.recipe.findMany).not.toHaveBeenCalled()
	})
	it('sends no private input or recipe to sidecar and filters unsafe links', async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					scope: 'curated_catalog',
					recipes: [
						{
							uid: 'public',
							name: 'Public salad',
							ingredients: 'carrot lettuce onion',
							source: 'Food Network',
							verified: '2026-09-13',
							url: 'https://www.foodnetwork.com/recipes/example'
						},
						{
							uid: 'bad',
							name: 'bad',
							ingredients: 'carrot',
							source: 'bad',
							verified: '',
							url: 'javascript:alert(1)'
						}
					]
				})
			)
		)
		const response = await POST({
			request: request({ ingredients: 'carrots, lettuce, onions' }),
			locals: locals(),
			fetch
		})
		const result = await response.json()
		expect(result.cookbook[0].url).toBe('/recipe/saved/view/')
		expect(result.publicRecipes.map((r) => r.uid)).toEqual(['public'])
		expect(fetch.mock.calls[0][0]).toBe('http://ai:8000/ai/public-recipes')
		expect(fetch.mock.calls[0][1].body).toBeUndefined()
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(JSON.stringify(result)).not.toContain('test-token')
	})
	it('keeps saved matches during a sidecar outage', async () => {
		const response = await POST({
			request: request({ ingredients: 'carrots' }),
			locals: locals(),
			fetch: vi.fn().mockRejectedValue(new Error('outage'))
		})
		const result = await response.json()
		expect(result.cookbook).toHaveLength(1)
		expect(result.publicStatus).toBe('unavailable')
	})
	it('rejects invalid input without network calls', async () => {
		const fetch = vi.fn()
		expect(
			(await POST({ request: request({ ingredients: '' }), locals: locals(), fetch })).status
		).toBe(400)
		expect(fetch).not.toHaveBeenCalled()
	})
})
