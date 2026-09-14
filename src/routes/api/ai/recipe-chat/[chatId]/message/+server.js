import { env } from '$env/dynamic/private'
import { json } from '@sveltejs/kit'
import { requireAuth } from '$lib/server/authHelpers'
import {
	deleteRecipeChat,
	getOwnedRecipeChat,
	MAX_BOUNDED_RETRIES,
	safeRecipeChatResponse
} from '$lib/server/aiRecipeChat'
import { rateLimitCheck } from '$lib/server/rateLimit'
import { cleanAiPrompt } from '$lib/aiRecipeChatIntent'

const LIVE_MODEL = 'gpt-5.4-nano'
const CHANGE_TOTAL_TIMEOUT_MS = 135_000
const CHANGE_ATTEMPT_TIMEOUT_MS = 22_000

async function requestChange(fetch, url, token, body, deadline) {
	const remaining = deadline - Date.now()
	if (remaining <= 0) return { response: null, result: null }
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-ai-operator-token': token
			},
			body,
			signal: AbortSignal.timeout(Math.max(1, Math.min(CHANGE_ATTEMPT_TIMEOUT_MS, remaining)))
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
	const text = cleanAiPrompt(payload?.text)
	if (!text || text.length > 2_000)
		return json(
			{
				status: 'invalid',
				message: 'Enter a change of 2,000 characters or fewer.',
				retryCount: 0,
				maxRetries: MAX_BOUNDED_RETRIES
			},
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
		const deadline = Date.now() + CHANGE_TOTAL_TIMEOUT_MS
		let retryCount = 0
		let attempt
		do {
			attempt = await requestChange(fetch, url, env.AI_SIDECAR_OPERATOR_TOKEN, body, deadline)
			if (
				attempt.response &&
				!(attempt.response.status === 503 && attempt.result?.detail?.retryable === true)
			)
				break
			if (retryCount >= MAX_BOUNDED_RETRIES) break
			retryCount += 1
		} while (true)
		if (!attempt.response)
			return json(
				{
					status: 'unavailable',
					message: `Cookbook AI is temporarily unavailable after ${MAX_BOUNDED_RETRIES} bounded retries.`,
					retryCount,
					maxRetries: MAX_BOUNDED_RETRIES
				},
				{ status: 503 }
			)
		if (attempt.response.status === 404) deleteRecipeChat(params.chatId)
		if (!attempt.response.ok)
			return json(
				{
					status: 'unavailable',
					message:
						retryCount > 0
							? 'Cookbook AI could not complete this change after bounded retries. Your recipe and change count were kept.'
							: 'Cookbook AI could not update this recipe. Your recipe and change count were kept.',
					retryCount,
					maxRetries: MAX_BOUNDED_RETRIES
				},
				{ status: attempt.response.status === 404 ? 404 : 503 }
			)
		return json(safeRecipeChatResponse(attempt.result, params.chatId, retryCount), {
			headers: { 'cache-control': 'no-store' }
		})
	} catch {
		return json(
			{ status: 'unavailable', message: 'Cookbook AI is temporarily unavailable.' },
			{ status: 503 }
		)
	}
}
