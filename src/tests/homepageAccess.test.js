import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findMany, groupBy } = vi.hoisted(() => ({
	findMany: vi.fn(),
	groupBy: vi.fn()
}))

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		recipe: { findMany },
		recipeLog: { groupBy }
	}
}))

import { load as loadHome } from '../routes/+page.server.js'
import { load as loadLayout } from '../routes/+layout.server.js'

const site = (dbSeeded, registrationAllowed = false) => ({
	dbSeeded,
	settings: { registrationAllowed },
	semantic: { enabled: false }
})

describe('public homepage access', () => {
	beforeEach(() => {
		findMany.mockReset()
		groupBy.mockReset()
	})

	it('shows login and first-admin choices before setup without querying recipes', async () => {
		const result = await loadHome({ locals: { site: site(false), user: null } })

		expect(result).toEqual({
			highlights: null,
			landing: { dbSeeded: false, registrationAllowed: false }
		})
		expect(findMany).not.toHaveBeenCalled()
	})

	it('shows login and registration choices for anonymous users when registration is open', async () => {
		const result = await loadHome({ locals: { site: site(true, true), user: null } })

		expect(result.landing).toEqual({ dbSeeded: true, registrationAllowed: true })
		expect(findMany).not.toHaveBeenCalled()
	})

	it('keeps the homepage and login route public before setup', async () => {
		for (const pathname of ['/', '/login', '/setup']) {
			const result = await loadLayout({
				locals: { site: site(false), user: null },
				url: new URL(`http://127.0.0.1:3000${pathname}`),
				request: new Request(`http://127.0.0.1:3000${pathname}`)
			})
			expect(result.dbSeed).toBe(false)
		}
	})

	it('redirects other unseeded routes to the public homepage', async () => {
		await expect(
			loadLayout({
				locals: { site: site(false), user: null },
				url: new URL('http://127.0.0.1:3000/recipes'),
				request: new Request('http://127.0.0.1:3000/recipes')
			})
		).rejects.toMatchObject({ status: 302, location: '/' })
	})
})
