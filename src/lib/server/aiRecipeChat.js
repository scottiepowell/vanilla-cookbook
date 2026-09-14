import { randomUUID } from 'node:crypto'

export const MAX_RECIPE_CHANGES = 10
export const MAX_BOUNDED_RETRIES = 5
const SESSION_TTL_MS = 60 * 60_000
const MAX_SESSIONS = 512
const sessions = new Map()
const labels = new Set(['strong', 'moderate', 'weak', 'none'])

function cleanSessions() {
	const now = Date.now()
	for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id)
	while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
}

export function createOwnedRecipeChat(userId, sidecarId) {
	cleanSessions()
	const id = randomUUID()
	sessions.set(id, { userId, sidecarId, expiresAt: Date.now() + SESSION_TTL_MS })
	return id
}

export function getOwnedRecipeChat(id, userId) {
	cleanSessions()
	const session = sessions.get(id)
	if (!session || session.userId !== userId) return null
	session.expiresAt = Date.now() + SESSION_TTL_MS
	return session
}

export function deleteRecipeChat(id) {
	sessions.delete(id)
}

function text(value, max) {
	return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function count(value, max = 10) {
	return Number.isInteger(value) && value >= 0 ? Math.min(value, max) : 0
}

function safeDraft(value) {
	if (!value || typeof value !== 'object') return null
	const title = text(value.title, 200)
	if (!title) return null
	return {
		title,
		description: text(value.description, 1000) || null,
		servings: Number.isInteger(value.servings) ? value.servings : null,
		ingredients: Array.isArray(value.ingredients)
			? value.ingredients.slice(0, 50).map((item) => ({
					quantity: text(item?.quantity, 40) || null,
					unit: text(item?.unit, 40) || null,
					name: text(item?.name, 160),
					note: text(item?.note, 240) || null
				}))
			: [],
		instructions: Array.isArray(value.instructions)
			? value.instructions.slice(0, 30).map((item, index) => ({
					step: index + 1,
					text: text(item?.text, 1000)
				}))
			: []
	}
}

function safeGrounding(result) {
	const retrieval = result?.retrieval
	const citations = Array.isArray(result?.citations) ? result.citations : []
	if (!retrieval && !citations.length) return null
	return {
		grounded: retrieval?.should_claim_rag_grounded === true,
		retrievedCount: count(retrieval?.retrieved_count),
		packedCount: count(retrieval?.packed_count),
		relevance: labels.has(retrieval?.relevance_category) ? retrieval.relevance_category : null,
		support: labels.has(retrieval?.support_level) ? retrieval.support_level : null,
		examples: [...new Set(citations.map((item) => text(item?.title, 120)).filter(Boolean))].slice(
			0,
			3
		)
	}
}

function assistantMessage(state, result) {
	if (state === 'clarification_needed') {
		return text(result?.clarification_question, 300) || 'What details should I use for this recipe?'
	}
	if (state === 'new_recipe_confirmation') {
		return 'That sounds like a different dish. Do you want to start a new recipe and discard the current draft?'
	}
	if (state === 'change_limit_reached') {
		return 'This recipe has reached its limit of ten changes. Start a new recipe to keep working.'
	}
	if (state === 'no_material_change') {
		return 'I kept the recipe as-is. Tell me a specific ingredient, method, serving, or instruction change you want.'
	}
	if (state === 'rejected') {
		return result?.draft
			? 'I could not apply that change. Your current recipe is still available; try a more specific edit.'
			: 'I need a clearer recipe idea before I can make a draft.'
	}
	if (state === 'draft_generated') {
		return 'Here is your recipe draft. If you want me to change anything, just let me know.'
	}
	return 'I updated the recipe. You can request another change below.'
}

export function safeRecipeChatResponse(result, chatId, retryCount = 0) {
	const state = text(result?.response_state, 60) || 'unavailable'
	return {
		status: 'ok',
		chatId,
		responseState: state,
		assistantMessage: assistantMessage(state, result),
		draft: safeDraft(result?.draft),
		grounding: safeGrounding(result),
		changeCount: count(result?.revision_count),
		maxChanges: MAX_RECIPE_CHANGES,
		retryCount: count(retryCount, MAX_BOUNDED_RETRIES),
		maxRetries: MAX_BOUNDED_RETRIES,
		replacementSuggested: state === 'new_recipe_confirmation'
	}
}

export function resetRecipeChatStoreForTests() {
	sessions.clear()
}
