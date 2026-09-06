import { env } from '$env/dynamic/private'
import { json } from '@sveltejs/kit'
import { randomUUID } from 'node:crypto'
import { requireAuth } from '$lib/server/authHelpers'
import {
	createOwnedRecipeChat,
	MAX_BOUNDED_RETRIES,
	safeRecipeChatResponse
} from '$lib/server/aiRecipeChat'
import { rateLimitCheck } from '$lib/server/rateLimit'

const LIVE_MODEL = 'gpt-5.4-nano'
const START_TOTAL_TIMEOUT_MS = 90_000
const START_ATTEMPT_TIMEOUT_MS = 22_000

function config() {
	if (env.AI_SIDECAR_ENABLED !== 'true' || !env.AI_SIDECAR_URL || !env.AI_SIDECAR_OPERATOR_TOKEN)
		return null
	return { url: env.AI_SIDECAR_URL.replace(/\/$/, ''), token: env.AI_SIDECAR_OPERATOR_TOKEN }
}

async function requestStart(fetch, url, token, body, requestId, deadline) {
	const remaining = deadline - Date.now()
	if (remaining <= 0) return { response: null, result: null, durationMs: 0 }
	const started = Date.now()
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-ai-operator-token': token,
				'x-request-id': requestId
			},
			body,
			signal: AbortSignal.timeout(Math.max(1, Math.min(START_ATTEMPT_TIMEOUT_MS, remaining)))
		})
		let result = null
		try {
			result = await response.json()
		} catch {
			// A non-JSON sidecar response is handled as unavailable.
		}
		return { response, result, durationMs: Date.now() - started }
	} catch {
		return { response: null, result: null, durationMs: Date.now() - started }
	}
}

function logStartOutcome({
	requestId,
	attempts,
	retried,
	status,
	sidecarDurationMs,
	totalDurationMs
}) {
	console.info(
		JSON.stringify({
			event: 'cookbook.ai.start',
			requestId,
			attempts,
			retried,
			status,
			sidecarDurationMs,
			totalDurationMs
		})
	)
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

	const requestId = randomUUID()
	const totalStarted = Date.now()
	const deadline = totalStarted + START_TOTAL_TIMEOUT_MS
	const body = JSON.stringify({
		text,
		source: typeof payload?.source === 'string' ? payload.source.slice(0, 500) : null,
		provider_mode: 'live',
		model: LIVE_MODEL,
		request_id: requestId
	})
	let attempts = 0
	let retryCount = 0
	let sidecarDurationMs = 0
	let outcome = 'unavailable'
	try {
		let attempt
		do {
			attempt = await requestStart(
				fetch,
				`${active.url}/ai/recipe-session/start`,
				active.token,
				body,
				requestId,
				deadline
			)
			attempts += 1
			sidecarDurationMs += attempt.durationMs
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
					message: 'Cookbook AI is temporarily unavailable after three bounded retries.',
					retryCount,
					maxRetries: MAX_BOUNDED_RETRIES
				},
				{ status: 503 }
			)
		if (!attempt.response.ok || typeof attempt.result?.interaction_id !== 'string')
			return json(
				{
					status: 'unavailable',
					message:
						retryCount > 0
							? 'Cookbook AI could not start this recipe after bounded retries.'
							: 'Cookbook AI could not start this recipe.',
					retryCount,
					maxRetries: MAX_BOUNDED_RETRIES
				},
				{ status: 503 }
			)
		const chatId = createOwnedRecipeChat(user.userId, attempt.result.interaction_id)
		outcome = 'ok'
		return json(safeRecipeChatResponse(attempt.result, chatId, retryCount), {
			headers: { 'cache-control': 'no-store' }
		})
	} catch {
		return json(
			{ status: 'unavailable', message: 'Cookbook AI is temporarily unavailable.' },
			{ status: 503 }
		)
	} finally {
		logStartOutcome({
			requestId,
			attempts,
			retried: retryCount > 0,
			status: outcome,
			sidecarDurationMs,
			totalDurationMs: Date.now() - totalStarted
		})
	}
}
