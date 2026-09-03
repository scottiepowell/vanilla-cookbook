import { env } from '$env/dynamic/private'
import { json } from '@sveltejs/kit'
import { requireAuth } from '$lib/server/authHelpers'
import {
	deleteRecipeChat,
	getOwnedRecipeChat,
	safeRecipeChatResponse
} from '$lib/server/aiRecipeChat'
import { rateLimitCheck } from '$lib/server/rateLimit'

const LIVE_MODEL = 'gpt-5.4-nano'

async function requestChange(fetch, url, token, body) {
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-ai-operator-token': token
			},
			body,
			signal: AbortSignal.timeout(30_000)
		})
		let result = null
		try {
			result = await response.json()
		} catch {
			// A non-JSON sidecar response is handled as unavailable.
		}
		return { response, result }
	} catch {
		return { response: null, result: null }
	}
}

export async function POST({ request, locals, fetch, params }) {
	const user = requireAuth(locals)
	const session = getOwnedRecipeChat(params.chatId, user.userId)
	if (!session)
		return json(
			{ status: 'expired', message: 'This recipe chat expired. Start a new recipe.' },
			{ status: 404 }
		)
	let payload
	try {
		payload = await request.json()
	} catch {
		return json(
			{ status: 'invalid', message: 'Send the requested change as JSON.' },
			{ status: 400 }
		)
	}
	const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
	if (!text || text.length > 2_000)
		return json(
			{ status: 'invalid', message: 'Enter a change of 2,000 characters or fewer.' },
			{ status: 400 }
		)
	if (!rateLimitCheck(`ai:chat:message:${user.userId}`, { limit: 12, windowMs: 15 * 60_000 }).ok)
		return json(
			{ status: 'limited', message: 'Please wait before making another change.' },
			{ status: 429 }
		)

	try {
		const base = env.AI_SIDECAR_URL?.replace(/\/$/, '')
		if (!base || !env.AI_SIDECAR_OPERATOR_TOKEN) throw new Error('unavailable')
		const url = `${base}/ai/recipe-session/${session.sidecarId}/message`
		const body = JSON.stringify({ text, provider_mode: 'live', model: LIVE_MODEL })
		let attempt = await requestChange(fetch, url, env.AI_SIDECAR_OPERATOR_TOKEN, body)
		let retried = false
		if (
			!attempt.response ||
			(attempt.response.status === 503 && attempt.result?.detail?.retryable === true)
		) {
			retried = true
			attempt = await requestChange(fetch, url, env.AI_SIDECAR_OPERATOR_TOKEN, body)
		}
		if (!attempt.response)
			return json(
				{
					status: 'unavailable',
					message: 'Cookbook AI is temporarily unavailable after one bounded retry.'
				},
				{ status: 503 }
			)
		if (attempt.response.status === 404) deleteRecipeChat(params.chatId)
		if (!attempt.response.ok)
			return json(
				{
					status: 'unavailable',
					message: retried
						? 'Cookbook AI could not complete this change after one bounded retry. Your recipe and change count were kept.'
						: 'Cookbook AI could not update this recipe. Your recipe and change count were kept.'
				},
				{ status: attempt.response.status === 404 ? 404 : 503 }
			)
		return json(safeRecipeChatResponse(attempt.result, params.chatId), {
			headers: { 'cache-control': 'no-store' }
		})
	} catch {
		return json(
			{ status: 'unavailable', message: 'Cookbook AI is temporarily unavailable.' },
			{ status: 503 }
		)
	}
}
