import { env } from '$env/dynamic/private'
import { json } from '@sveltejs/kit'
import { requireAuth } from '$lib/server/authHelpers'
import { createOwnedRecipeChat, safeRecipeChatResponse } from '$lib/server/aiRecipeChat'
import { rateLimitCheck } from '$lib/server/rateLimit'

const LIVE_MODEL = 'gpt-5.4-nano'

function config() {
	if (env.AI_SIDECAR_ENABLED !== 'true' || !env.AI_SIDECAR_URL || !env.AI_SIDECAR_OPERATOR_TOKEN)
		return null
	return { url: env.AI_SIDECAR_URL.replace(/\/$/, ''), token: env.AI_SIDECAR_OPERATOR_TOKEN }
}

export async function POST({ request, locals, fetch }) {
	const user = requireAuth(locals)
	const active = config()
	if (!active)
		return json({ status: 'unavailable', message: 'Cookbook AI is unavailable.' }, { status: 503 })
	let payload
	try {
		payload = await request.json()
	} catch {
		return json({ status: 'invalid', message: 'Send a recipe idea as JSON.' }, { status: 400 })
	}
	const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
	if (!text || text.length > 12_000)
		return json(
			{ status: 'invalid', message: 'Enter a recipe idea of 12,000 characters or fewer.' },
			{ status: 400 }
		)
	if (!rateLimitCheck(`ai:chat:start:${user.userId}`, { limit: 3, windowMs: 5 * 60_000 }).ok)
		return json(
			{ status: 'limited', message: 'Please wait before starting another recipe.' },
			{ status: 429 }
		)

	try {
		const response = await fetch(`${active.url}/ai/recipe-session/start`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-ai-operator-token': active.token },
			body: JSON.stringify({
				text,
				source: typeof payload?.source === 'string' ? payload.source.slice(0, 500) : null,
				provider_mode: 'live',
				model: LIVE_MODEL
			}),
			signal: AbortSignal.timeout(30_000)
		})
		const result = await response.json()
		if (!response.ok || typeof result?.interaction_id !== 'string')
			return json(
				{ status: 'unavailable', message: 'Cookbook AI could not start this recipe.' },
				{ status: 503 }
			)
		const chatId = createOwnedRecipeChat(user.userId, result.interaction_id)
		return json(safeRecipeChatResponse(result, chatId), {
			headers: { 'cache-control': 'no-store' }
		})
	} catch {
		return json(
			{ status: 'unavailable', message: 'Cookbook AI is temporarily unavailable.' },
			{ status: 503 }
		)
	}
}
