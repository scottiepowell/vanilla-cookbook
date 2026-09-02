import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$env/dynamic/private', () => ({
	env: {
		AI_SIDECAR_ENABLED: 'true',
		AI_SIDECAR_URL: 'http://cookbook-public-ai:8000',
		AI_SIDECAR_OPERATOR_TOKEN: 'opaque-test-token'
	}
}))

import { POST } from '../routes/api/ai/import-recipe/+server.js'

function request(payload) {
	return new Request('https://cookbook.roadmaps.link/api/ai/import-recipe', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload)
	})
}

describe('authenticated AI sidecar proxy', () => {
	let sidecarFetch

	beforeEach(() => {
		sidecarFetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					draft: { title: 'Test soup', ingredients: [], instructions: [] },
					model: 'gpt-5.4-nano',
					warnings: []
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		)
	})

	it('requires a real core session before contacting the sidecar', async () => {
		await expect(
			POST({ request: request({ text: 'Soup' }), locals: { user: null }, fetch: sidecarFetch })
		).rejects.toMatchObject({ status: 401 })
		expect(sidecarFetch).not.toHaveBeenCalled()
	})

	it('pins live requests to nano and keeps the internal token out of the response', async () => {
		const response = await POST({
			request: request({ text: 'Soup ingredients and directions' }),
			locals: { user: { userId: 'opaque-user' } },
			fetch: sidecarFetch
		})
		const body = await response.json()
		const [, options] = sidecarFetch.mock.calls[0]

		expect(response.status).toBe(200)
		expect(JSON.parse(options.body)).toMatchObject({ provider_mode: 'live', model: 'gpt-5.4-nano' })
		expect(options.headers['x-ai-operator-token']).toBe('opaque-test-token')
		expect(JSON.stringify(body)).not.toContain('opaque-test-token')
		expect(body).toMatchObject({ status: 'ok', model: 'gpt-5.4-nano' })
	})

	it('rejects oversized input before contacting the sidecar', async () => {
		const response = await POST({
			request: request({ text: 'x'.repeat(12_001) }),
			locals: { user: { userId: 'opaque-user' } },
			fetch: sidecarFetch
		})

		expect(response.status).toBe(413)
		expect(sidecarFetch).not.toHaveBeenCalled()
	})
})
