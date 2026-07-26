import { requireAuth } from './authHelpers.js'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const MOCK_ISSUER = 'https://mock-oidc.local.test'
const MOCK_PROVIDER = 'mock-oidc'
const APPROVED_IMAGE = 'local/vanilla-cookbook-adapter:0034k'
const SAFE_CLAIMS = new Set(['iss', 'sub', 'email', 'email_verified', 'name', 'picture'])
const FORBIDDEN_FIELDS = new Set([
	'userId',
	'user_id',
	'session',
	'cookie',
	'token',
	'providerToken',
	'oauthCode',
	'storageGrant',
	'providerGrant',
	'authorization'
])

function safeText(value, max = 200) {
	return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

function hasForbiddenFields(value) {
	if (!value || typeof value !== 'object') return false
	if (Array.isArray(value)) return value.some(hasForbiddenFields)
	return Object.entries(value).some(([key, nested]) => FORBIDDEN_FIELDS.has(key) || hasForbiddenFields(nested))
}

function isLoopbackTarget(value) {
	try {
		const target = new URL(value || '')
		return target.protocol === 'http:' && LOOPBACK_HOSTS.has(target.hostname) &&
			[3000, null].includes(target.port ? Number(target.port) : null) &&
			!target.username && !target.password && !target.search && !target.hash
	} catch {
		return false
	}
}

export function mockOidcSessionFixtureGuard(env = process.env) {
	const reasons = []
	if (env.NODE_ENV === 'production') reasons.push('production_mode')
	if (env.CI === 'true' || env.GITHUB_ACTIONS === 'true') reasons.push('ci_context')
	if (env.AWS_REGION || env.CLOUDFLARE_TUNNEL_TOKEN || env.TUNNEL_TOKEN) reasons.push('deployment_context')
	if (env.RUN_LOCAL_MOCK_OIDC_SESSION !== '1') reasons.push('fixture_disabled')
	if (env.LOCAL_MOCK_OIDC_SESSION_APPROVED !== '1') reasons.push('approval_required')
	if (env.SYNTHETIC_AUTH_FIXTURE !== '1') reasons.push('synthetic_fixture_required')
	if (env.VANILLA_COOKBOOK_IMAGE !== APPROVED_IMAGE) reasons.push('approved_image_required')
	if (!isLoopbackTarget(env.COOKBOOK_TARGET_URL || '')) reasons.push('loopback_target_required')
	if (env.GOOGLE_CLIENT_SECRET || env.OIDC_CLIENT_SECRET || env.GITHUB_CLIENT_SECRET) reasons.push('real_credentials_forbidden')
	if (env.OIDC_STORAGE_SCOPES || env.GOOGLE_STORAGE_SCOPES) reasons.push('storage_scopes_forbidden')
	return { allowed: reasons.length === 0, reasons }
}

export function validateMockOidcClaims(claims) {
	if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
		return { status: 'invalid', code: 'invalid_claims' }
	}
	if (Object.keys(claims).some((key) => !SAFE_CLAIMS.has(key))) {
		return { status: 'invalid', code: 'unsupported_claim' }
	}
	if (claims.iss !== MOCK_ISSUER) return { status: 'invalid', code: 'issuer_rejected' }
	const subject = safeText(claims.sub, 200)
	if (!subject) return { status: 'invalid', code: 'subject_required' }
	const email = safeText(claims.email, 320)?.toLowerCase() || null
	if (email && claims.email_verified !== true) return { status: 'review_required', code: 'email_not_verified' }
	return {
		status: 'accepted',
		providerId: MOCK_PROVIDER,
		issuer: MOCK_ISSUER,
		subject,
		email,
		emailVerified: claims.email_verified === true,
		displayName: safeText(claims.name, 160),
		avatarUrl: safeText(claims.picture, 500)
	}
}

async function linkCoreIdentity(profile, store) {
	const existingLink = await store.findByProviderSubject(profile.providerId, profile.subject)
	if (existingLink) {
		return { status: 'linked', result: 'replay', userId: existingLink.userId }
	}
	if (profile.email) {
		const existingUser = await store.findByVerifiedEmail(profile.email)
		if (existingUser) return { status: 'review_required', code: 'account_link_confirmation_required' }
	}
	const user = await store.createAuthUser({
		email: profile.email,
		displayName: profile.displayName
	})
	await store.createProviderLink({
		providerId: profile.providerId,
		providerUserId: profile.subject,
		userId: user.id
	})
	return { status: 'linked', result: 'created', userId: user.id }
}

function sessionEvent(cookieJar, method = 'GET') {
	const cookies = {
		get: (name) => cookieJar.get(name) ?? null,
		set: (name, value) => cookieJar.set(name, value),
		delete: (name) => cookieJar.delete(name)
	}
	return {
		request: new Request('http://127.0.0.1:3000/api/adapter/dev-only/auth/mock-oidc', { method }),
		cookies
	}
}

async function establishAndValidateSession({ auth, cookieJar, userId }) {
	const loginRequest = auth.handleRequest(sessionEvent(cookieJar, 'GET'))
	const session = await auth.createSession({ userId, attributes: {} })
	loginRequest.setSession(session)
	const validationRequest = auth.handleRequest(sessionEvent(cookieJar, 'GET'))
	const validated = await validationRequest.validate()
	const authenticatedUser = validated?.user ? requireAuth({ user: validated.user }) : null
	return { loginRequest, validationRequest, session, validated, authenticatedUser }
}

function safeEnvelope(extra = {}) {
	return {
		status: 'verified',
		verification: 'local_mock_oidc_session',
		...extra
	}
}

/**
 * Exercise the core identity-link and Lucia session boundaries with synthetic
 * claims. The caller supplies core-owned stores and a commit service so this
 * fixture remains separate from production routes and configured databases.
 */
export async function runMockOidcSessionFixture({
	env = process.env,
	approved = false,
	claims,
	auth,
	identityStore,
	cookieJar,
	candidate,
	commitService
} = {}) {
	const guard = mockOidcSessionFixtureGuard(env)
	if (!guard.allowed) return { status: 'unavailable', code: 'mock_session_unavailable', reasons: guard.reasons }
	if (approved !== true) return { status: 'unavailable', code: 'explicit_confirmation_required' }
	if (hasForbiddenFields(claims) || hasForbiddenFields(candidate)) return { status: 'invalid', code: 'identity_assertion_rejected' }
	if (!auth || !identityStore || !cookieJar || typeof commitService !== 'function') {
		return { status: 'unavailable', code: 'core_fixture_dependencies_required' }
	}
	const profile = validateMockOidcClaims(claims)
	if (profile.status !== 'accepted') return profile
	const link = await linkCoreIdentity(profile, identityStore)
	if (link.status !== 'linked') return link
	const sessionState = await establishAndValidateSession({ auth, cookieJar, userId: link.userId })
	if (!sessionState.authenticatedUser || sessionState.authenticatedUser.userId !== link.userId) {
		return { status: 'invalid', code: 'authenticated_user_unavailable' }
	}
	const commit = await commitService({ candidate, user: sessionState.authenticatedUser })
	if (!commit || !['committed', 'duplicate_review_required', 'conflict'].includes(commit.status)) {
		return { status: 'invalid', code: 'save_ownership_verification_failed' }
	}
	await auth.invalidateSession(sessionState.session.sessionId)
	sessionState.validationRequest.setSession(null)
	const afterLogout = auth.handleRequest(sessionEvent(cookieJar, 'GET'))
	const invalidated = await afterLogout.validate()
	if (invalidated !== null) return { status: 'invalid', code: 'logout_invalidation_failed' }
	return safeEnvelope({
		link_status: link.result,
		authenticated_user: 'core_context_verified',
		save_status: commit.status,
		recipe_uid: commit.recipe_uid,
		idempotency_status: commit.idempotency_status,
		logout_status: 'invalidated',
		cookie_value: undefined
	})
}

export function hasMockOidcIdentityAssertion(value) {
	return hasForbiddenFields(value)
}

export { APPROVED_IMAGE, MOCK_ISSUER, MOCK_PROVIDER }
