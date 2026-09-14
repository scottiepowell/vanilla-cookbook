import { describe, expect, it } from 'vitest'
import {
	getGoogleIdentityDescriptor,
	googleIdentityConfigGuard,
	linkCoreOidcIdentity,
	normalizeOidcProfile,
	rejectSidecarIdentityClaims
} from '../lib/server/oidcIdentityFoundation.js'

const validConfig = {
	NODE_ENV: 'development',
	LOCAL_OIDC_MOCK_ENABLED: '1',
	LOCAL_OIDC_MOCK_APPROVED: '1',
	OIDC_PROVIDER: 'google',
	COOKBOOK_TARGET_URL: 'http://127.0.0.1:3000/'
}

const validClaims = {
	iss: 'https://accounts.google.com',
	sub: 'mock-google-subject-1',
	email: 'fixture@example.test',
	email_verified: true,
	name: 'Fixture User',
	picture: 'https://example.test/avatar.png'
}

describe('Google-first OIDC identity foundation', () => {
	it('uses identity-only Google scopes and no storage scopes', () => {
		const descriptor = getGoogleIdentityDescriptor()
		expect(descriptor.identityScopes).toEqual(['openid', 'email', 'profile'])
		expect(descriptor.storageScopes).toEqual([])
	})

	it('fails closed unless explicit local mock gates are present', () => {
		expect(googleIdentityConfigGuard({}).allowed).toBe(false)
		expect(googleIdentityConfigGuard(validConfig)).toEqual({ allowed: true, reasons: [] })
	})

	it('rejects production, exposed, deployment, credentials, and storage scopes', () => {
		for (const change of [
			{ NODE_ENV: 'production' },
			{ COOKBOOK_TARGET_URL: 'https://cookbook.roadmaps.link/' },
			{ GITHUB_ACTIONS: 'true' },
			{ GOOGLE_CLIENT_SECRET: 'must-not-be-used' },
			{ OIDC_STORAGE_SCOPES: 'drive.file' }
		]) {
			expect(googleIdentityConfigGuard({ ...validConfig, ...change }).allowed).toBe(false)
		}
	})

	it('normalizes a valid profile without returning token or session material', () => {
		const profile = normalizeOidcProfile({ claims: validClaims })
		expect(profile).toMatchObject({
			status: 'accepted',
			providerId: 'google',
			subject: 'mock-google-subject-1',
			emailVerified: true
		})
		expect(JSON.stringify(profile)).not.toMatch(/token|secret|cookie|session|password/i)
	})

	it('rejects invalid issuer, missing subject, and unverified email safely', () => {
		expect(normalizeOidcProfile({ claims: { ...validClaims, iss: 'https://evil.example' } }).code).toBe('issuer_rejected')
		expect(normalizeOidcProfile({ claims: { ...validClaims, sub: '' } }).code).toBe('subject_required')
		expect(normalizeOidcProfile({ claims: { ...validClaims, email_verified: false } }).status).toBe('review_required')
	})

	it('rejects unknown claims and sidecar identity assertions', () => {
		expect(normalizeOidcProfile({ claims: { ...validClaims, userId: 'sidecar-user' } }).code).toBe('unsupported_profile_claim')
		expect(rejectSidecarIdentityClaims({ userId: 'sidecar-user' })).toBe(true)
		expect(rejectSidecarIdentityClaims({ session: 'not-a-session' })).toBe(true)
		expect(rejectSidecarIdentityClaims({ candidate: 'safe' })).toBe(false)
	})

	it('keeps provider-link and AuthUser mapping inside the injected core store', async () => {
		const calls = []
		const store = {
			findByProviderSubject: async () => null,
			findByVerifiedEmail: async () => null,
			createAuthUser: async (attrs) => {
				calls.push(['user', attrs])
				return { id: 'core-user-1' }
			},
			createProviderLink: async (link) => calls.push(['link', link])
		}
		const result = await linkCoreOidcIdentity({ profile: normalizeOidcProfile({ claims: validClaims }), store })
		expect(result).toEqual({ status: 'linked', result: 'created', coreUserId: 'core-user-1' })
		expect(calls[1][1]).toMatchObject({ providerId: 'google', providerUserId: 'mock-google-subject-1', userId: 'core-user-1' })
	})

	it('replays an existing provider link and requires review for email collision', async () => {
		const profile = normalizeOidcProfile({ claims: validClaims })
		expect(await linkCoreOidcIdentity({ profile, store: { findByProviderSubject: async () => ({ userId: 'core-user-1' }) } })).toMatchObject({ status: 'linked', result: 'replay' })
		expect(await linkCoreOidcIdentity({ profile, store: { findByProviderSubject: async () => null, findByVerifiedEmail: async () => ({ id: 'existing-user' }) } })).toEqual({ status: 'review_required', code: 'account_link_confirmation_required' })
	})

	it('does not create a link when core storage is unavailable', async () => {
		const result = await linkCoreOidcIdentity({ profile: normalizeOidcProfile({ claims: validClaims }) })
		expect(result).toEqual({ status: 'blocked', code: 'core_store_required' })
	})
})

