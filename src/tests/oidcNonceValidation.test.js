import { beforeEach, describe, expect, it, vi } from 'vitest'

const oidcClient = vi.hoisted(() => ({
	authorizationCodeGrant: vi.fn(),
	discovery: vi.fn()
}))

vi.mock('$env/dynamic/private', () => ({
	env: {
		OIDC_ISSUER_URL: 'https://accounts.google.com',
		OIDC_CLIENT_ID: 'test-client-id',
		OIDC_CLIENT_SECRET: 'test-client-secret',
		OIDC_SCOPES: 'openid email profile',
		ORIGIN: 'https://cookbook.roadmaps.link'
	}
}))

vi.mock('openid-client', () => ({
	...oidcClient,
	allowInsecureRequests: Symbol('allowInsecureRequests'),
	buildAuthorizationUrl: vi.fn(),
	calculatePKCECodeChallenge: vi.fn(),
	fetchUserInfo: vi.fn(),
	randomNonce: vi.fn(),
	randomPKCECodeVerifier: vi.fn(),
	randomState: vi.fn()
}))

import { resetOidcConfig, validateCallback } from '../lib/server/oidc.js'

describe('OIDC callback nonce validation', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		resetOidcConfig()
		oidcClient.discovery.mockResolvedValue({})
		oidcClient.authorizationCodeGrant.mockResolvedValue({
			claims: () => ({
				sub: 'opaque-subject',
				email: 'fixture@example.test',
				email_verified: true,
				preferred_username: 'fixture-user'
			})
		})
	})

	it('passes the stored nonce as expectedNonce to openid-client', async () => {
		const callbackUrl = new URL(
			'https://cookbook.roadmaps.link/api/oauth/callback?code=opaque-code&state=opaque-state'
		)

		await validateCallback(callbackUrl, 'opaque-state', 'opaque-code-verifier', 'opaque-nonce')

		expect(oidcClient.authorizationCodeGrant).toHaveBeenCalledWith({}, callbackUrl, {
			pkceCodeVerifier: 'opaque-code-verifier',
			expectedState: 'opaque-state',
			expectedNonce: 'opaque-nonce'
		})
		expect(oidcClient.authorizationCodeGrant.mock.calls[0][2]).not.toHaveProperty('nonce')
	})
})
