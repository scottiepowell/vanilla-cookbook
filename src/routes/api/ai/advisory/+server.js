import { env } from '$env/dynamic/private'
import { json } from '@sveltejs/kit'
import { requireAuth } from '$lib/server/authHelpers'
import { rateLimitCheck } from '$lib/server/rateLimit'

const TASKS = new Set([
	'recipe_titles',
	'ingredient_parse',
	'instruction_cleanup',
	'substitution_ideas',
	'shopping_group',
	'pantry_ideas',
	'meal_ideas',
	'plain_language',
	'query_expansion'
])

export async function POST({ request, locals, fetch }) {
	const user = requireAuth(locals)
	let payload
	try {
		payload = await request.json()
	} catch {
		return json({ status: 'invalid', message: 'Enter a short request.' }, { status: 400 })
	}
	const task = payload?.task
	const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
	if (!TASKS.has(task) || !text || text.length > 1500 || payload?.publicOrSynthetic !== true)
		return json(
			{
				status: 'invalid',
				message: 'Choose a task, enter public or invented text, and confirm the data boundary.'
			},
			{ status: 400 }
		)
	if (!rateLimitCheck(`ai:advisory:${user.userId}`, { limit: 10, windowMs: 15 * 60_000 }).ok)
		return json(
			{ status: 'limited', message: 'Please wait before trying more ideas.' },
			{ status: 429 }
		)
	if (env.AI_SIDECAR_ENABLED !== 'true' || !env.AI_SIDECAR_URL || !env.AI_SIDECAR_OPERATOR_TOKEN)
		return json(
			{ status: 'unavailable', message: 'Kitchen ideas are unavailable.' },
			{ status: 503 }
		)
	try {
		const response = await fetch(`${env.AI_SIDECAR_URL.replace(/\/$/, '')}/ai/advisory`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-ai-operator-token': env.AI_SIDECAR_OPERATOR_TOKEN
			},
			body: JSON.stringify({ task, text, public_or_synthetic: true }),
			signal: AbortSignal.timeout(20_000)
		})
		const result = await response.json()
		if (!response.ok || !Array.isArray(result?.items)) throw new Error('unavailable')
		return json(
			{ status: result.status, items: result.items, provider: result.provider },
			{ headers: { 'cache-control': 'no-store' } }
		)
	} catch {
		return json(
			{ status: 'unavailable', message: 'Kitchen ideas are temporarily unavailable.' },
			{ status: 503 }
		)
	}
}
