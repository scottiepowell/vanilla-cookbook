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
					warnings: [],
					retrieval: {
						retrieved_count: 3,
						packed_count: 2,
						relevance_category: 'strong',
						support_level: 'strong',
						should_claim_rag_grounded: true,
						query: 'private retrieval query',
						matched_result_ids: ['private-result-id']
					},
					citations: [
						{
							id: 'private-citation-id',
							source_id: 'private-source-id',
							title: 'Hearty vegetable soup',
							snippet: 'private dataset snippet',
							provenance: { source_path: 'private/dataset/path.csv' }
						},
						{ title: 'Quick tomato soup' },
						{ title: 'Hearty vegetable soup' }
					]
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
		expect(body.grounding).toEqual({
			grounded: true,
			retrievedCount: 3,
			packedCount: 2,
			citationCount: 3,
			relevance: 'strong',
			support: 'strong',
			examples: ['Hearty vegetable soup', 'Quick tomato soup']
		})
		const serializedBody = JSON.stringify(body)
		for (const privateValue of [
			'private retrieval query',
			'private-result-id',
			'private-citation-id',
			'private-source-id',
			'private dataset snippet',
			'private/dataset/path.csv'
		]) {
			expect(serializedBody).not.toContain(privateValue)
		}
	})

	it('drops unrecognized grounding labels and bounds public counts and titles', async () => {
		sidecarFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					draft: { title: 'Test soup', ingredients: [], instructions: [] },
					model: 'gpt-5.4-nano',
					retrieval: {
						retrieved_count: 5000,
						packed_count: -1,
						relevance_category: 'internal-label',
						support_level: 'strong'
					},
					citations: Array.from({ length: 12 }, (_, index) => ({
						title: `Example ${index + 1}`
					}))
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		)

		const response = await POST({
			request: request({ text: 'Soup ingredients and directions' }),
			locals: { user: { userId: 'bounded-user' } },
			fetch: sidecarFetch
		})
		const body = await response.json()

		expect(body.grounding).toMatchObject({
			retrievedCount: 10,
			packedCount: 0,
			citationCount: 10,
			relevance: null,
			support: 'strong'
		})
		expect(body.grounding.examples).toEqual(['Example 1', 'Example 2', 'Example 3'])
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
