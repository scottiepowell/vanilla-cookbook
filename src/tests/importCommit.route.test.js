import { describe, expect, it, vi } from 'vitest'

const { requireAuth } = vi.hoisted(() => ({ requireAuth: vi.fn() }))
vi.mock('$lib/server/authHelpers', () => ({
	requireAuth,
	jsonSuccess: (data, status = 200) => new Response(JSON.stringify(data), { status }),
	jsonError: (status, data) => new Response(JSON.stringify(data), { status })
}))
vi.mock('$lib/server/prisma', () => ({ prisma: {} }))

import { POST } from '../routes/api/adapter/recipes/import-candidate/commit/+server.js'

describe('POST /api/adapter/recipes/import-candidate/commit', () => {
	it('is unavailable by default before authentication or storage access', async () => {
		const prior = process.env.COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED
		delete process.env.COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED
		const response = await POST({ request: { json: vi.fn() }, locals: {} })
		const body = await response.json()
		if (prior === undefined) delete process.env.COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED
		else process.env.COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED = prior
		expect(response.status).toBe(503)
		expect(body.code).toBe('adapter.local_only_unavailable')
		expect(JSON.stringify(body)).not.toMatch(/cookie|token|session|stack|sqlite|prisma/i)
	})

	it('does not bypass normal auth when the local gate is enabled', async () => {
		const prior = process.env.COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED
		const target = process.env.COOKBOOK_TARGET_URL
		process.env.COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED = 'true'
		process.env.COOKBOOK_TARGET_URL = 'http://127.0.0.1:3000/'
		requireAuth.mockImplementationOnce(() => { throw new Error('Authentication required') })
		await expect(POST({ request: { json: vi.fn() }, locals: {} })).rejects.toThrow('Authentication required')
		if (prior === undefined) delete process.env.COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED
		else process.env.COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED = prior
		if (target === undefined) delete process.env.COOKBOOK_TARGET_URL
		else process.env.COOKBOOK_TARGET_URL = target
	})

	it('refuses non-loopback targets before auth or storage access', async () => {
		const prior = process.env.COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED
		const target = process.env.COOKBOOK_TARGET_URL
		process.env.COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED = 'true'
		process.env.COOKBOOK_TARGET_URL = 'https://cookbook.roadmaps.link/'
		const response = await POST({ request: { json: vi.fn() }, locals: {} })
		if (prior === undefined) delete process.env.COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED
		else process.env.COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED = prior
		if (target === undefined) delete process.env.COOKBOOK_TARGET_URL
		else process.env.COOKBOOK_TARGET_URL = target
		expect(response.status).toBe(503)
	})
})
