import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('$env/dynamic/private', () => ({
	env: {
		AI_SIDECAR_ENABLED: 'true',
		AI_SIDECAR_URL: 'http://cookbook-public-ai:8000',
		AI_SIDECAR_OPERATOR_TOKEN: 'opaque-chat-token'
	}
}))

import { resetRecipeChatStoreForTests } from '../lib/server/aiRecipeChat.js'
import {
	cleanAiPrompt,
	explicitNewRecipeRequest,
	proposedReplacementIdea,
	replacementConfirmationAnswer
} from '../lib/aiRecipeChatIntent.js'
import { POST as startChat } from '../routes/api/ai/recipe-chat/start/+server.js'
import { POST as messageChat } from '../routes/api/ai/recipe-chat/[chatId]/message/+server.js'
import { DELETE as discardChat } from '../routes/api/ai/recipe-chat/[chatId]/+server.js'

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
		expect(body).toMatchObject({
			changeCount: 0,
			maxChanges: 10,
			retryCount: 0,
			maxRetries: 5
		})
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

	it('renders latest bounded retry usage directly below the change count', () => {
		const page = readFileSync(join(process.cwd(), 'src/routes/ai/+page.svelte'), 'utf8')
		const changes = page.indexOf('{changeCount} of {maxChanges} changes used')
		const retries = page.indexOf(
			'{retryCount} of {maxRetries} bounded retries used for the latest request'
		)

		expect(changes).toBeGreaterThan(-1)
		expect(retries).toBeGreaterThan(changes)
	})

	it('treats empty, whitespace, and invisible-only browser prompts as empty', () => {
		expect(cleanAiPrompt('')).toBe('')
		expect(cleanAiPrompt('  \r\n\t ')).toBe('')
		expect(cleanAiPrompt('\u200B\u200D\u2060\uFEFF')).toBe('')
		expect(cleanAiPrompt('  add mushrooms  ')).toBe('add mushrooms')
	})

	it('rejects an empty initial prompt before any sidecar call or retry', async () => {
		const sidecarFetch = vi.fn()
		const response = await startChat({
			request: request({ text: ' \u200B ' }),
			locals: { user: { userId: 'empty-start-owner' } },
			fetch: sidecarFetch
		})

		expect(response.status).toBe(400)
		expect(sidecarFetch).not.toHaveBeenCalled()
		expect(await response.json()).toMatchObject({
			status: 'invalid',
			retryCount: 0,
			maxRetries: 5
		})
	})

	it('parses typed recipe replacement confirmation without treating richer ideas as yes or no', () => {
		expect(replacementConfirmationAnswer('Yes, I do.')).toBe('confirm')
		expect(replacementConfirmationAnswer('keep the current recipe')).toBe('keep')
		expect(replacementConfirmationAnswer('make it chicken and rice instead')).toBeNull()
	})

	it('extracts an explicit new recipe idea for an immediate restart', () => {
		expect(
			explicitNewRecipeRequest('Hey, start a new recipe with rice, chicken, and mushrooms')
		).toEqual({
			explicit: true,
			idea: 'rice, chicken, and mushrooms'
		})
		expect(explicitNewRecipeRequest('add mushrooms')).toEqual({ explicit: false, idea: '' })
	})

	it('extracts a clearer proposed dish from replacement wording', () => {
		expect(
			proposedReplacementIdea(
				'change the pasta to rice and make the dish more like a chicken and rice with mushrooms dish'
			)
		).toBe('chicken and rice with mushrooms')
		expect(proposedReplacementIdea('change the pasta to rice')).toBe('rice recipe')
		expect(
			proposedReplacementIdea(
				"All right let's switch the recipe and I want to do a pasta bake with chicken, rigatoni, and spinach."
			)
		).toBe('a pasta bake with chicken, rigatoni, and spinach.')
		expect(
			proposedReplacementIdea(
				"All right let's go with fried rice. With some teriyaki and pork, and saute some vegetables."
			)
		).toBe('fried rice. With some teriyaki and pork, and saute some vegetables.')
	})

	it('discards the old binding before a clean replacement start', async () => {
		const oldFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(sidecarResult()), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		)
		const oldChat = await (
			await startChat({
				request: request({ text: 'cheese omelet' }),
				locals: { user: { userId: 'replacement-owner' } },
				fetch: oldFetch
			})
		).json()

		const discarded = await discardChat({
			locals: { user: { userId: 'replacement-owner' } },
			params: { chatId: oldChat.chatId }
		})
		expect(discarded.status).toBe(200)

		const staleFetch = vi.fn()
		const staleResponse = await messageChat({
			request: request({ text: 'add spinach' }),
			locals: { user: { userId: 'replacement-owner' } },
			fetch: staleFetch,
			params: { chatId: oldChat.chatId }
		})
		expect(staleResponse.status).toBe(404)
		expect(staleFetch).not.toHaveBeenCalled()

		const newFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(sidecarResult()), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		)
		const newChat = await (
			await startChat({
				request: request({ text: 'chicken rigatoni spinach pasta bake' }),
				locals: { user: { userId: 'replacement-owner' } },
				fetch: newFetch
			})
		).json()
		const forwarded = JSON.parse(newFetch.mock.calls[0][1].body)

		expect(newChat.chatId).not.toBe(oldChat.chatId)
		expect(forwarded.text).toBe('chicken rigatoni spinach pasta bake')
		expect(forwarded.text).not.toContain('omelet')
	})

	it('can recover on the sixth initial attempt with an identical body and idempotency key', async () => {
		const sidecarFetch = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ detail: { retryable: true } }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ detail: { retryable: true } }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ detail: { retryable: true } }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ detail: { retryable: true } }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ detail: { retryable: true } }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				})
			)
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
		expect(sidecarFetch).toHaveBeenCalledTimes(6)
		const bodies = sidecarFetch.mock.calls.map((call) => call[1].body)
		const requestIds = sidecarFetch.mock.calls.map((call) => call[1].headers['x-request-id'])
		expect(new Set(bodies).size).toBe(1)
		expect(new Set(requestIds).size).toBe(1)
		expect((await response.json()).retryCount).toBe(5)
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

	it('limits transport recovery to five initial retries', async () => {
		const sidecarFetch = vi.fn().mockRejectedValue(new Error('temporary transport failure'))

		const response = await startChat({
			request: request({ text: 'bean soup' }),
			locals: { user: { userId: 'initial-transport-owner' } },
			fetch: sidecarFetch
		})

		expect(response.status).toBe(503)
		expect(sidecarFetch).toHaveBeenCalledTimes(6)
		expect(await response.json()).toMatchObject({ retryCount: 5, maxRetries: 5 })
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

	it('rejects an empty follow-up before any sidecar call or retry', async () => {
		const startFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(sidecarResult()), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		)
		const started = await (
			await startChat({
				request: request({ text: 'bean soup' }),
				locals: { user: { userId: 'empty-change-owner' } },
				fetch: startFetch
			})
		).json()
		const messageFetch = vi.fn()
		const response = await messageChat({
			request: request({ text: ' \uFEFF ' }),
			locals: { user: { userId: 'empty-change-owner' } },
			fetch: messageFetch,
			params: { chatId: started.chatId }
		})

		expect(response.status).toBe(400)
		expect(messageFetch).not.toHaveBeenCalled()
		expect(await response.json()).toMatchObject({
			status: 'invalid',
			retryCount: 0,
			maxRetries: 5
		})
	})

	it('can recover on the sixth retryable change attempt with the identical request', async () => {
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
			.mockResolvedValue(
				new Response(JSON.stringify({ detail: { retryable: true } }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ detail: { retryable: true } }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ detail: { retryable: true } }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ detail: { retryable: true } }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ detail: { retryable: true } }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				})
			)
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
		expect(messageFetch).toHaveBeenCalledTimes(6)
		expect(new Set(messageFetch.mock.calls.map((call) => call[1].body)).size).toBe(1)
		const body = await response.json()
		expect(body.changeCount).toBe(1)
		expect(body.retryCount).toBe(5)
	})
})
