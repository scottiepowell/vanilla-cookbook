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

	it('retries one safe transient provider failure and returns the recovered draft', async () => {
		sidecarFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					detail: {
						status: 'unavailable',
						safe_unavailable_category: 'provider_transient_failure',
						safe_guidance: 'The AI provider returned a temporary failure.',
						retryable: true
					}
				}),
				{ status: 503, headers: { 'content-type': 'application/json' } }
			)
		)

		const response = await POST({
			request: request({ text: 'Green chile enchiladas with chicken' }),
			locals: { user: { userId: 'retry-user' } },
			fetch: sidecarFetch
		})
		const body = await response.json()

		expect(sidecarFetch).toHaveBeenCalledTimes(2)
		expect(response.status).toBe(200)
		expect(body).toMatchObject({ status: 'ok', model: 'gpt-5.4-nano' })
	})

	it('does not retry deterministic provider failures', async () => {
		sidecarFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					detail: {
						status: 'unavailable',
						safe_unavailable_category: 'provider_account_or_quota_unavailable',
						safe_guidance: 'The AI provider is unavailable because of account or quota limits.',
						retryable: false
					}
				}),
				{ status: 503, headers: { 'content-type': 'application/json' } }
			)
		)

		const response = await POST({
			request: request({ text: 'Green chile enchiladas with chicken' }),
			locals: { user: { userId: 'non-retry-user' } },
			fetch: sidecarFetch
		})
		const body = await response.json()

		expect(sidecarFetch).toHaveBeenCalledTimes(1)
		expect(response.status).toBe(503)
		expect(body.message).toContain('account or quota')
	})
})
