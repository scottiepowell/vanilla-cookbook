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
		const response = await fetch(`${base}/ai/recipe-session/${session.sidecarId}/message`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-ai-operator-token': env.AI_SIDECAR_OPERATOR_TOKEN
			},
			body: JSON.stringify({ text, provider_mode: 'live', model: LIVE_MODEL }),
			signal: AbortSignal.timeout(30_000)
		})
		if (response.status === 404) deleteRecipeChat(params.chatId)
		const result = await response.json()
		if (!response.ok)
			return json(
				{ status: 'unavailable', message: 'Cookbook AI could not update this recipe.' },
				{ status: response.status === 404 ? 404 : 503 }
			)
		return json(safeRecipeChatResponse(result, params.chatId), {
			headers: { 'cache-control': 'no-store' }
		})
	} catch {
		return json(
			{ status: 'unavailable', message: 'Cookbook AI is temporarily unavailable.' },
			{ status: 503 }
		)
	}
}
