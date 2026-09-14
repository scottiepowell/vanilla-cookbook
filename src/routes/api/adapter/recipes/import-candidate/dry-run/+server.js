import { requireAuth, jsonError, jsonSuccess } from '$lib/server/authHelpers'
import { createDryRunRegistry, dryRunRecipeImport } from '$lib/server/importAdapter'

const routeIdempotencyRegistry = createDryRunRegistry()
const FORBIDDEN_IDENTITY_FIELDS = new Set(['userId', 'owner', 'session', 'cookie', 'token', 'auth'])

function containsForbiddenIdentityField(candidate) {
	return candidate && typeof candidate === 'object' && Object.keys(candidate).some((key) => FORBIDDEN_IDENTITY_FIELDS.has(key))
}

export async function POST({ request, locals }) {
	const user = requireAuth(locals)
	let candidate

	try {
		candidate = await request.json()
	} catch {
		return jsonError(400, { error: 'Invalid candidate payload.', code: 'adapter.invalid_payload' })
	}

	if (containsForbiddenIdentityField(candidate)) {
		return jsonError(400, { error: 'Ownership comes from the authenticated core context.', code: 'adapter.identity_assertion_rejected' })
	}

	const result = dryRunRecipeImport({
		candidate,
		user,
		idempotencyRegistry: routeIdempotencyRegistry
	})
	const hasConflict = result.idempotency_status?.state === 'conflict'
	const status = hasConflict ? 409 : result.status === 'invalid' ? 422 : 200
	return jsonSuccess(result, status)
}
