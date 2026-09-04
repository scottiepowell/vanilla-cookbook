import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$env/dynamic/private', () => ({
	env: {
		AI_SIDECAR_ENABLED: 'true',
		AI_SIDECAR_URL: 'http://cookbook-public-ai:8000',
		AI_SIDECAR_OPERATOR_TOKEN: 'opaque-chat-token'
	}
}))

import { resetRecipeChatStoreForTests } from '../lib/server/aiRecipeChat.js'
import { POST as startChat } from '../routes/api/ai/recipe-chat/start/+server.js'
import { POST as messageChat } from '../routes/api/ai/recipe-chat/[chatId]/message/+server.js'

function request(payload) {
	return new Request('https://cookbook.roadmaps.link/api/ai/recipe-chat', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload)
	})
}

function sidecarResult(state = 'draft_generated') {
	return {
		interaction_id: 'private-sidecar-session',
		response_state: state,
		revision_count: state === 'draft_revised' ? 1 : 0,
		draft: {
			title: 'Test recipe',
			description: 'A safe draft.',
			servings: 4,
			ingredients: [{ name: 'beans', quantity: '2', unit: 'cups' }],
			instructions: [{ text: 'Cook the beans.' }]
		},
		retrieval: {
			retrieved_count: 3,
			packed_count: 2,
			relevance_category: 'strong',
			support_level: 'strong',
			should_claim_rag_grounded: true,
			query: 'private query',
			matched_result_ids: ['private-result-id']
		},
		citations: [{ title: 'Example recipe', id: 'private-id', snippet: 'private snippet' }]
	}
}

describe('public recipe chat proxy', () => {
	beforeEach(() => resetRecipeChatStoreForTests())

	it('starts an owned chat and exposes only the bounded public response', async () => {
		const sidecarFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(sidecarResult()), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		)
		const response = await startChat({
			request: request({ text: 'bean soup' }),
			locals: { user: { userId: 'chat-owner' } },
			fetch: sidecarFetch
		})
		const body = await response.json()
		const serialized = JSON.stringify(body)

		expect(response.status).toBe(200)
		expect(body.chatId).toBeTruthy()
		expect(body.chatId).not.toBe('private-sidecar-session')
		expect(body).toMatchObject({ changeCount: 0, maxChanges: 10 })
		expect(body.grounding).toMatchObject({ retrievedCount: 3, packedCount: 2 })
		const forwarded = JSON.parse(sidecarFetch.mock.calls[0][1].body)
		expect(forwarded.request_id).toMatch(/^[0-9a-f-]{36}$/)
		expect(sidecarFetch.mock.calls[0][1].headers['x-request-id']).toBe(forwarded.request_id)
		for (const value of [
			'opaque-chat-token',
			'private-sidecar-session',
			'private query',
			'private-result-id',
			'private-id',
			'private snippet'
		])
			expect(serialized).not.toContain(value)
	})

	it('retries one retryable initial failure with an identical body and idempotency key', async () => {
		const sidecarFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ detail: { retryable: true } }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(sidecarResult()), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			)

		const response = await startChat({
			request: request({ text: 'bean soup' }),
			locals: { user: { userId: 'initial-retry-owner' } },
			fetch: sidecarFetch
		})

		expect(response.status).toBe(200)
		expect(sidecarFetch).toHaveBeenCalledTimes(2)
		expect(sidecarFetch.mock.calls[1][1].body).toBe(sidecarFetch.mock.calls[0][1].body)
		expect(sidecarFetch.mock.calls[1][1].headers['x-request-id']).toBe(
			sidecarFetch.mock.calls[0][1].headers['x-request-id']
		)
	})

	it('does not retry a deterministic initial failure', async () => {
		const sidecarFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ detail: { retryable: false } }), {
				status: 503,
				headers: { 'content-type': 'application/json' }
			})
		)

		const response = await startChat({
			request: request({ text: 'bean soup' }),
			locals: { user: { userId: 'initial-no-retry-owner' } },
			fetch: sidecarFetch
		})

		expect(response.status).toBe(503)
		expect(sidecarFetch).toHaveBeenCalledTimes(1)
	})

	it('limits transport recovery to one initial retry', async () => {
		const sidecarFetch = vi.fn().mockRejectedValue(new Error('temporary transport failure'))

		const response = await startChat({
			request: request({ text: 'bean soup' }),
			locals: { user: { userId: 'initial-transport-owner' } },
			fetch: sidecarFetch
		})

		expect(response.status).toBe(503)
		expect(sidecarFetch).toHaveBeenCalledTimes(2)
	})

	it('keeps a chat bound to the core user', async () => {
		const startFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(sidecarResult()), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		)
		const started = await (
			await startChat({
				request: request({ text: 'bean soup' }),
				locals: { user: { userId: 'owner-a' } },
				fetch: startFetch
			})
		).json()
		const messageFetch = vi.fn()
		const response = await messageChat({
			request: request({ text: 'add carrots' }),
			locals: { user: { userId: 'owner-b' } },
			fetch: messageFetch,
			params: { chatId: started.chatId }
		})

		expect(response.status).toBe(404)
		expect(messageFetch).not.toHaveBeenCalled()
	})

	it('forwards an owned change with the pinned model', async () => {
		const startFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(sidecarResult()), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		)
		const started = await (
			await startChat({
				request: request({ text: 'bean soup' }),
				locals: { user: { userId: 'owner-c' } },
				fetch: startFetch
			})
		).json()
		const messageFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(sidecarResult('draft_revised')), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		)
		const response = await messageChat({
			request: request({ text: 'add carrots' }),
			locals: { user: { userId: 'owner-c' } },
			fetch: messageFetch,
			params: { chatId: started.chatId }
		})
		const body = await response.json()
		const forwarded = JSON.parse(messageFetch.mock.calls[0][1].body)

		expect(response.status).toBe(200)
		expect(body.changeCount).toBe(1)
		expect(forwarded).toMatchObject({
			text: 'add carrots',
			provider_mode: 'live',
			model: 'gpt-5.4-nano'
		})
	})

	it('retries one retryable change failure with the identical request', async () => {
		const startFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(sidecarResult()), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		)
		const started = await (
			await startChat({
				request: request({ text: 'bean soup' }),
				locals: { user: { userId: 'retry-owner' } },
				fetch: startFetch
			})
		).json()
		const messageFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ detail: { retryable: true } }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(sidecarResult('draft_revised')), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			)

		const response = await messageChat({
			request: request({ text: 'add mushrooms' }),
			locals: { user: { userId: 'retry-owner' } },
			fetch: messageFetch,
			params: { chatId: started.chatId }
		})

		expect(response.status).toBe(200)
		expect(messageFetch).toHaveBeenCalledTimes(2)
		expect(messageFetch.mock.calls[1][1].body).toBe(messageFetch.mock.calls[0][1].body)
		expect((await response.json()).changeCount).toBe(1)
	})
})
