import { requireAuth, jsonError, jsonSuccess } from '$lib/server/authHelpers'
import { prisma } from '$lib/server/prisma'
import { commitRecipeImport, containsCommitIdentityAssertion } from '$lib/server/importCommit.js'

function loopbackTarget(value) {
	try {
		const target = new URL(value || 'http://127.0.0.1:3000/')
		return target.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(target.hostname)
	} catch {
		return false
	}
}

function localCommitEnabled() {
	return process.env.COOKBOOK_ADAPTER_LOCAL_COMMIT_ENABLED === 'true' &&
		loopbackTarget(process.env.COOKBOOK_TARGET_URL) &&
		!process.env.CLOUDFLARE_TUNNEL_TOKEN &&
		!process.env.GITHUB_ACTIONS &&
		!process.env.AWS_REGION
}

export async function POST({ request, locals }) {
	if (!localCommitEnabled()) return jsonError(503, { error: 'Local commit adapter is unavailable.', code: 'adapter.local_only_unavailable' })
	const user = requireAuth(locals)
	let body
	try {
		body = await request.json()
	} catch {
		return jsonError(400, { error: 'Invalid commit payload.', code: 'adapter.invalid_payload' })
	}
	const { candidate, confirm_save: confirmSave } = body || {}
	if (containsCommitIdentityAssertion(candidate)) {
		return jsonError(400, { error: 'Ownership comes from the authenticated core context.', code: 'adapter.identity_assertion_rejected' })
	}
	const result = await commitRecipeImport({ candidate, user, prisma, confirmSave })
	const status = result.status === 'committed' ? 201 : result.status === 'conflict' ? 409 : result.status === 'duplicate_review_required' ? 409 : result.status === 'invalid' ? 422 : result.status === 'unauthenticated' ? 401 : 400
	return jsonSuccess(result, status)
}
