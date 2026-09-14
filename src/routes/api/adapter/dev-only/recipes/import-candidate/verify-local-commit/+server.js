import { runLocalAuthCommitVerification, hasLocalTransportIdentityAssertion } from '$lib/server/localAuthCommitVerification.js'

export async function POST({ request }) {
	let body
	try {
		body = await request.json()
	} catch {
		return new Response(JSON.stringify({ status: 'unavailable', code: 'invalid_payload' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
	}
	if (!body || typeof body !== 'object' || hasLocalTransportIdentityAssertion(body) || hasLocalTransportIdentityAssertion(body.candidate)) {
		return new Response(JSON.stringify({ status: 'unavailable', code: 'identity_assertion_rejected' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
	}
	const result = await runLocalAuthCommitVerification({
		candidate: body.candidate,
		approved: body.approve_local_write === true,
		env: process.env
	})
	const status = result.status === 'verified' ? 200 : result.code === 'explicit_confirmation_required' ? 400 : 503
	return new Response(JSON.stringify(result), { status, headers: { 'Content-Type': 'application/json' } })
}
