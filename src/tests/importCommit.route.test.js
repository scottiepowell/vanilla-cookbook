import { afterEach, describe, expect, it, vi } from 'vitest'

const { requireAuth } = vi.hoisted(() => ({ requireAuth: vi.fn() }))
vi.mock('$lib/server/authHelpers', () => ({
	requireAuth,
	jsonSuccess: (data, status = 200) => new Response(JSON.stringify(data), { status }),
	jsonError: (status, data) => new Response(JSON.stringify(data), { status })
}))
vi.mock('$lib/server/prisma', () => ({ prisma: {} }))

import { POST } from '../routes/api/adapter/recipes/import-candidate/commit/+server.js'

afterEach(() => {
	vi.unstubAllEnvs()
	requireAuth.mockReset()
})

describe('POST /api/adapter/recipes/import-candidate/commit', () => {
	it('is unavailable by default before authentication or storage access', async () => {
		vi.stubEnv('COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED', '')
		const response = await POST({ request: { json: vi.fn() }, locals: {} })
		const body = await response.json()
		expect(response.status).toBe(503)
		expect(body.code).toBe('adapter.local_only_unavailable')
		expect(JSON.stringify(body)).not.toMatch(/cookie|token|session|stack|sqlite|prisma/i)
	})

	it('does not bypass normal auth when the local gate is enabled', async () => {
		vi.stubEnv('COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED', 'true')
		vi.stubEnv('COOKBOOK_TARGET_URL', 'http://127.0.0.1:3000/')
		vi.stubEnv('CLOUDFLARE_TUNNEL_TOKEN', '')
		vi.stubEnv('GITHUB_ACTIONS', '')
		vi.stubEnv('AWS_REGION', '')
		requireAuth.mockImplementationOnce(() => {
			throw new Error('Authentication required')
		})
		await expect(POST({ request: { json: vi.fn() }, locals: {} })).rejects.toThrow(
			'Authentication required'
		)
	})

	it('refuses non-loopback targets before auth or storage access', async () => {
		vi.stubEnv('COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED', 'true')
		vi.stubEnv('COOKBOOK_TARGET_URL', 'https://cookbook.roadmaps.link/')
		const response = await POST({ request: { json: vi.fn() }, locals: {} })
		expect(response.status).toBe(503)
	})
})
