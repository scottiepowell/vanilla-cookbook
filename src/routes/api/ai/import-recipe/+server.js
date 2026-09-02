import { env } from '$env/dynamic/private'
import { json } from '@sveltejs/kit'
import { requireAuth } from '$lib/server/authHelpers'
import { rateLimitCheck } from '$lib/server/rateLimit'

const MAX_RECIPE_TEXT_CHARS = 12_000
const REQUEST_TIMEOUT_MS = 30_000
const LIVE_MODEL = 'gpt-5.4-nano'

function unavailable(message = 'Cookbook AI is temporarily unavailable.') {
	return json({ status: 'unavailable', message }, { status: 503 })
}

function sidecarConfig() {
	if (env.AI_SIDECAR_ENABLED !== 'true') return null
	if (!env.AI_SIDECAR_URL || !env.AI_SIDECAR_OPERATOR_TOKEN) return null

	try {
		const url = new URL(env.AI_SIDECAR_URL)
		if (!['http:', 'https:'].includes(url.protocol)) return null
		return {
			url: new URL('/ai/import-recipe', `${url.toString().replace(/\/$/, '')}/`),
			token: env.AI_SIDECAR_OPERATOR_TOKEN
		}
	} catch {
		return null
	}
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals, fetch }) {
	const user = requireAuth(locals)

	let payload
	try {
		payload = await request.json()
	} catch {
		return json(
			{ status: 'invalid', message: 'Recipe text must be sent as JSON.' },
			{ status: 400 }
		)
	}

	const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
	if (!text) {
		return json(
			{ status: 'invalid', message: 'Paste a recipe before asking AI to structure it.' },
			{ status: 400 }
		)
	}
	if (text.length > MAX_RECIPE_TEXT_CHARS) {
		return json(
			{
				status: 'invalid',
				message: `Recipe text must be ${MAX_RECIPE_TEXT_CHARS} characters or fewer.`
			},
			{ status: 413 }
		)
	}

	const rateLimit = rateLimitCheck(`ai:import:${user.userId}`, { limit: 3, windowMs: 5 * 60_000 })
	if (!rateLimit.ok) {
		return json(
			{
				status: 'limited',
				message: 'AI recipe drafting is limited to three requests every five minutes.'
			},
			{ status: 429, headers: { 'retry-after': String(Math.ceil(rateLimit.resetMs / 1000)) } }
		)
	}

	const config = sidecarConfig()
	if (!config) return unavailable()

	try {
		const response = await fetch(config.url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-ai-operator-token': config.token
			},
			body: JSON.stringify({
				text,
				source: typeof payload?.source === 'string' ? payload.source.slice(0, 500) : null,
				provider_mode: 'live',
				model: LIVE_MODEL
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		})

		let result = null
		try {
			result = await response.json()
		} catch {
			return unavailable()
		}

		if (!response.ok) {
			return json(
				{
					status: 'unavailable',
					message: result?.detail?.safe_guidance || 'Cookbook AI could not structure this recipe.'
				},
				{ status: response.status >= 400 && response.status < 500 ? response.status : 503 }
			)
		}

		return json(
			{
				status: 'ok',
				draft: result?.draft ?? null,
				model: result?.model === LIVE_MODEL ? LIVE_MODEL : null,
				warnings: Array.isArray(result?.warnings) ? result.warnings.slice(0, 10) : []
			},
			{ headers: { 'cache-control': 'no-store' } }
		)
	} catch {
		return unavailable()
	}
}
