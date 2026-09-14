import { describe, expect, it, vi } from 'vitest'

vi.mock('$env/dynamic/private', () => ({
	env: {
		AI_SIDECAR_ENABLED: 'true',
		AI_SIDECAR_URL: 'http://cookbook-public-ai:8000',
		AI_SIDECAR_OPERATOR_TOKEN: 'opaque-advisory-token'
	}
}))

import { POST } from '../routes/api/ai/advisory/+server.js'

function request(body) {
	return new Request('https://cookbook.roadmaps.link/api/ai/advisory', {
		method: 'POST',
		body: JSON.stringify(body),
		headers: { 'content-type': 'application/json' }
	})
}

describe('authenticated public-fixture advisory proxy', () => {
	it('rejects missing public-data confirmation before calling the sidecar', async () => {
		const fetch = vi.fn()
		const response = await POST({
			request: request({ task: 'shopping_group', text: 'carrots' }),
			locals: { user: { userId: 'advisory-a' } },
			fetch
		})
		expect(response.status).toBe(400)
		expect(fetch).not.toHaveBeenCalled()
	})

	it('forwards only bounded input and hides the operator token in its response', async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({
				status: 'ok', provider: 'groq', items: [{ source: 'carrots', suggestion: 'Produce aisle' }],
				usage: { input_tokens: 20, output_tokens: 10 }
			}), { status: 200 })
		)
		const response = await POST({
			request: request({ task: 'shopping_group', text: 'carrots', publicOrSynthetic: true }),
			locals: { user: { userId: 'advisory-b' } },
			fetch
		})
		const body = await response.json()
		expect(response.status).toBe(200)
		expect(body.items).toEqual([{ source: 'carrots', suggestion: 'Produce aisle' }])
		expect(JSON.stringify(body)).not.toContain('opaque-advisory-token')
		expect(body.usage).toBeUndefined()
		expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
			task: 'shopping_group', text: 'carrots', public_or_synthetic: true
		})
	})
})
