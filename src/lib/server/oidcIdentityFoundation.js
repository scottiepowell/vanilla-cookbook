const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])

export const GOOGLE_IDENTITY_DESCRIPTOR = Object.freeze({
	providerId: 'google',
	issuer: 'https://accounts.google.com',
	identityScopes: Object.freeze(['openid', 'email', 'profile']),
	storageScopes: Object.freeze([])
})

const SAFE_PROFILE_KEYS = new Set([
	'iss',
	'sub',
	'email',
	'email_verified',
	'name',
	'given_name',
	'family_name',
	'picture'
])

function safeText(value, max = 200) {
	return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

function isLoopbackTarget(value) {
	try {
		const target = new URL(value || 'http://127.0.0.1:3000/')
		return target.protocol === 'http:' && LOOPBACK_HOSTS.has(target.hostname)
	} catch {
		return false
	}
}

export function googleIdentityConfigGuard(config = {}) {
	const reasons = []
	if (config.NODE_ENV === 'production') reasons.push('production_mode')
	if (config.CI === 'true' || config.GITHUB_ACTIONS === 'true') reasons.push('ci_context')
	if (config.AWS_REGION || config.CLOUDFLARE_TUNNEL_TOKEN) reasons.push('deployment_context')
	if (config.LOCAL_OIDC_MOCK_ENABLED !== '1') reasons.push('mock_disabled')
	if (config.LOCAL_OIDC_MOCK_APPROVED !== '1') reasons.push('approval_required')
	if (config.OIDC_PROVIDER !== 'google') reasons.push('google_provider_required')
	if (!isLoopbackTarget(config.COOKBOOK_TARGET_URL)) reasons.push('loopback_target_required')
	if (config.GOOGLE_CLIENT_SECRET || config.OIDC_CLIENT_SECRET) reasons.push('real_credentials_forbidden')
	if (config.OIDC_STORAGE_SCOPES) reasons.push('storage_scopes_forbidden')
	return { allowed: reasons.length === 0, reasons }
}

export function getGoogleIdentityDescriptor() {
	return {
		providerId: GOOGLE_IDENTITY_DESCRIPTOR.providerId,
		issuer: GOOGLE_IDENTITY_DESCRIPTOR.issuer,
		identityScopes: [...GOOGLE_IDENTITY_DESCRIPTOR.identityScopes],
		storageScopes: []
	}
}

export function normalizeOidcProfile({ provider = GOOGLE_IDENTITY_DESCRIPTOR, claims } = {}) {
	if (!provider || provider.providerId !== 'google') {
		return { status: 'invalid', code: 'unsupported_provider' }
	}
	if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
		return { status: 'invalid', code: 'invalid_profile' }
	}
	if (Object.keys(claims).some((key) => !SAFE_PROFILE_KEYS.has(key))) {
		return { status: 'invalid', code: 'unsupported_profile_claim' }
	}
	const issuer = safeText(claims.iss, 120)
	const subject = safeText(claims.sub, 200)
	if (!issuer || !GOOGLE_ISSUERS.has(issuer)) return { status: 'invalid', code: 'issuer_rejected' }
	if (issuer !== provider.issuer && issuer !== 'accounts.google.com') {
		return { status: 'invalid', code: 'issuer_rejected' }
	}
	if (!subject) return { status: 'invalid', code: 'subject_required' }
	const email = safeText(claims.email, 320)?.toLowerCase() || null
	const emailVerified = claims.email_verified === true
	if (email && !emailVerified) {
		return { status: 'review_required', code: 'email_not_verified' }
	}
	return {
		status: 'accepted',
		providerId: provider.providerId,
		issuer: provider.issuer,
		subject,
		email,
		emailVerified,
		displayName: safeText(claims.name || claims.given_name, 160),
		avatarUrl: safeText(claims.picture, 500)
	}
}

export function rejectSidecarIdentityClaims(input = {}) {
	const forbidden = ['userId', 'session', 'cookie', 'token', 'providerToken', 'storageGrant']
	return forbidden.some((key) => Object.prototype.hasOwnProperty.call(input, key))
}

export async function linkCoreOidcIdentity({ profile, store } = {}) {
	if (!profile || profile.status !== 'accepted') {
		return { status: 'rejected', code: profile?.code || 'profile_not_accepted' }
	}
	if (!store || typeof store.findByProviderSubject !== 'function') {
		return { status: 'blocked', code: 'core_store_required' }
	}
	const existingLink = await store.findByProviderSubject(profile.providerId, profile.subject)
	if (existingLink) {
		return { status: 'linked', result: 'replay', coreUserId: existingLink.userId }
	}
	if (profile.email && typeof store.findByVerifiedEmail === 'function') {
		const existingUser = await store.findByVerifiedEmail(profile.email)
		if (existingUser) return { status: 'review_required', code: 'account_link_confirmation_required' }
	}
	if (typeof store.createAuthUser !== 'function' || typeof store.createProviderLink !== 'function') {
		return { status: 'blocked', code: 'core_link_store_required' }
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
	return { status: 'linked', result: 'created', coreUserId: user.id }
}

