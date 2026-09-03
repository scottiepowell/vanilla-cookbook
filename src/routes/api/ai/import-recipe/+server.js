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

async function requestDraft(fetch, config, body) {
	try {
		const response = await fetch(config.url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-ai-operator-token': config.token
			},
			body,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		})

		let result = null
		try {
			result = await response.json()
		} catch {
			// A non-JSON upstream response is handled as unavailable below.
		}
		return { response, result }
	} catch {
		return { response: null, result: null }
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

	const body = JSON.stringify({
		text,
		source: typeof payload?.source === 'string' ? payload.source.slice(0, 500) : null,
		provider_mode: 'live',
		model: LIVE_MODEL
	})
	let attempt = await requestDraft(fetch, config, body)
	let retried = false
	if (
		!attempt.response ||
		(attempt.response.status === 503 && attempt.result?.detail?.retryable === true)
	) {
		retried = true
		attempt = await requestDraft(fetch, config, body)
	}

	if (!attempt.response) {
		return unavailable('Cookbook AI is temporarily unavailable after one bounded retry.')
	}

	if (!attempt.response.ok) {
		const safeMessage = retried
			? 'Cookbook AI is temporarily unavailable after one bounded retry. Please try again later.'
			: attempt.result?.detail?.safe_guidance || 'Cookbook AI could not structure this recipe.'
		return json(
			{ status: 'unavailable', message: safeMessage },
			{
				status:
					attempt.response.status >= 400 && attempt.response.status < 500
						? attempt.response.status
						: 503
			}
		)
	}

	return json(
		{
			status: 'ok',
			draft: attempt.result?.draft ?? null,
			model: attempt.result?.model === LIVE_MODEL ? LIVE_MODEL : null,
			warnings: Array.isArray(attempt.result?.warnings) ? attempt.result.warnings.slice(0, 10) : []
		},
		{ headers: { 'cache-control': 'no-store' } }
	)
}
