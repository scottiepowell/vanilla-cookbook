import { describe, expect, it, vi } from 'vitest'

const { requireAuth } = vi.hoisted(() => ({ requireAuth: vi.fn() }))

vi.mock('$lib/server/authHelpers', () => ({
	requireAuth,
	jsonSuccess: (data, status = 200) => new Response(JSON.stringify(data), { status }),
	jsonError: (status, data) => new Response(JSON.stringify(data), { status })
}))

import { POST } from '../routes/api/adapter/recipes/import-candidate/dry-run/+server.js'

const user = { userId: 'synthetic-route-user', username: 'synthetic', isAdmin: false }

function candidate(idempotencyKey) {
	return {
		title: 'Route Dry-Run Fixture',
		description: 'Reviewed fixture.',
		servings: 2,
		ingredients: ['1 cup beans'],
		instructions: ['Warm the beans.'],
		source: 'reviewed-fixture',
		source_url: 'https://example.test/route-fixture',
		notes: 'Reviewed provenance.',
		idempotency_key: idempotencyKey,
		contract_version: 'cookbook-import-candidate.v1',
		schema_version: 'recipe.v1'
	}
}

function requestFor(body) {
	return { json: vi.fn().mockResolvedValue(body) }
}

describe('POST /api/adapter/recipes/import-candidate/dry-run', () => {
	it('rejects anonymous requests through the normal auth helper', async () => {
		requireAuth.mockImplementationOnce(() => {
			throw new Error('Authentication required')
		})

		await expect(POST({ request: requestFor(candidate('anonymous-route')), locals: {} })).rejects.toThrow('Authentication required')
	})

	it('derives ownership from core locals and returns a safe mapped preview', async () => {
		requireAuth.mockReturnValueOnce(user)

		const response = await POST({ request: requestFor(candidate('valid-route')), locals: { user } })
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(body.status).toBe('dry_run_ready')
		expect(body.mapped_recipe_preview).toMatchObject({
			name: 'Route Dry-Run Fixture',
			servings: '2',
			ingredients: '1 cup beans',
			directions: '1. Warm the beans.'
		})
	})

	it('rejects sidecar identity assertions before adapter processing', async () => {
		requireAuth.mockReturnValueOnce(user)

		const response = await POST({ request: requestFor({ ...candidate('identity-route'), userId: 'not-accepted' }), locals: { user } })
		const body = await response.json()

		expect(response.status).toBe(400)
		expect(body.code).toBe('adapter.identity_assertion_rejected')
		expect(JSON.stringify(body)).not.toContain('not-accepted')
	})

	it('returns safe validation errors without mutation or provider data', async () => {
		requireAuth.mockReturnValueOnce(user)

		const response = await POST({
			request: requestFor({ ...candidate('invalid-route'), title: '', source_url: 'javascript:alert(1)', prompt: 'provider body' }),
			locals: { user }
		})
		const body = await response.json()

		expect(response.status).toBe(422)
		expect(body.status).toBe('invalid')
		expect(JSON.stringify(body)).not.toContain('provider body')
		expect(JSON.stringify(body)).not.toContain('javascript')
		expect(JSON.stringify(body)).not.toMatch(/prisma|sqlite|cookie|token|session|stack/i)
	})

	it('reports replay and same-key conflict without creating a recipe', async () => {
		const key = 'route-replay-fixture'
		requireAuth.mockReturnValue(user)

		const first = await POST({ request: requestFor(candidate(key)), locals: { user } })
		const replay = await POST({ request: requestFor(candidate(key)), locals: { user } })
		const conflict = await POST({ request: requestFor({ ...candidate(key), description: 'changed' }), locals: { user } })

		expect(first.status).toBe(200)
		expect((await replay.json()).idempotency_status.state).toBe('replay')
		expect(conflict.status).toBe(409)
		expect((await conflict.json()).idempotency_status.state).toBe('conflict')
	})
})
