import { describe, expect, it } from 'vitest'
import { IDENTITY_ONLY_OIDC_SCOPES, GOOGLE_OIDC_ISSUER, oidcConfigGuard } from '../lib/server/oidc.js'

const valid = {
	NODE_ENV: 'development',
	OIDC_ISSUER_URL: GOOGLE_OIDC_ISSUER,
	OIDC_CLIENT_ID: 'local-client-id-not-a-secret',
	OIDC_CLIENT_SECRET: 'local-secret-only-in-ignored-env',
	OIDC_SCOPES: IDENTITY_ONLY_OIDC_SCOPES.join(' '),
	ORIGIN: 'http://127.0.0.1:3000'
}

describe('manual local Google OIDC configuration guard', () => {
	it('fails closed without local credentials and gates', () => {
		expect(oidcConfigGuard({}).allowed).toBe(false)
		expect(oidcConfigGuard(valid)).toEqual({ allowed: true, reasons: [] })
	})

	it('rejects production, exposed, deployment, and storage-scope contexts', () => {
		for (const change of [
			{ NODE_ENV: 'production' },
			{ ORIGIN: 'https://cookbook.roadmaps.link' },
			{ CI: 'true' },
			{ OIDC_SCOPES: 'openid email profile drive.file' },
			{ OIDC_STORAGE_SCOPES: 'drive.file' },
			{ OIDC_ISSUER_URL: 'https://issuer.example.test' }
		]) expect(oidcConfigGuard({ ...valid, ...change }).allowed).toBe(false)
	})

	it('requires identity-only Google scopes', () => {
		expect(oidcConfigGuard({ ...valid, OIDC_SCOPES: 'openid profile' }).reasons).toContain('identity_only_scopes_required')
	})
})
