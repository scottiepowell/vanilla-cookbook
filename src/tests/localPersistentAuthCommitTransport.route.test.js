import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runLocalPersistentAuthCommitVerification } = vi.hoisted(() => ({ runLocalPersistentAuthCommitVerification: vi.fn() }))
vi.mock('../lib/server/localPersistentAuthCommitVerification.js', () => ({
	runLocalPersistentAuthCommitVerification,
	hasLocalPersistentIdentityAssertion: (value) => value && typeof value === 'object' && (Object.hasOwn(value, 'userId') || Object.hasOwn(value, 'cookie') || Object.hasOwn(value, 'session'))
}))

import { POST } from '../routes/api/adapter/dev-only/recipes/import-candidate/verify-local-persistent-commit/+server.js'

const candidate = {
	title: 'Persistent Transport Fixture',
	description: 'Reviewed local fixture.',
	servings: 2,
	ingredients: ['1 cup beans'],
	instructions: ['Warm the beans.'],
	source_url: 'https://example.test/fixture',
	notes: 'Reviewed fixture.',
	idempotency_key: 'persistent-transport-fixture',
	contract_version: 'cookbook-import-candidate.v1',
	schema_version: 'recipe.v1'
}

function request(body) {
	return { json: vi.fn().mockResolvedValue(body) }
}

describe('core local persistent synthetic commit route', () => {
	beforeEach(() => vi.clearAllMocks())

	it('requires explicit confirmation and delegates only candidate/approval', async () => {
		runLocalPersistentAuthCommitVerification.mockResolvedValueOnce({ status: 'unavailable', code: 'explicit_confirmation_required' })
		const response = await POST({ request: request({ candidate }) })
		expect(response.status).toBe(400)
		expect(runLocalPersistentAuthCommitVerification).toHaveBeenCalledWith({ candidate, approved: false, env: process.env })
	})

	it('returns only the safe persistent verification envelope', async () => {
		runLocalPersistentAuthCommitVerification.mockResolvedValueOnce({
			status: 'verified',
			verification: 'local_persistent_synthetic_auth',
			recipe_uid: 'opaque-local-uid',
			persistent_user_status: 'created_synthetic_core_user',
			cookie: 'must-not-be-returned'
		})
		const response = await POST({ request: request({ candidate, approve_local_write: true }) })
		const body = await response.json()
		expect(response.status).toBe(200)
		expect(body.status).toBe('verified')
		expect(response.headers.get('set-cookie')).toBeNull()
	})

	it('rejects identity, session, and cookie claims before the core service', async () => {
		const response = await POST({ request: request({ candidate: { ...candidate, userId: 'sidecar-user' }, approve_local_write: true }) })
		expect(response.status).toBe(400)
		expect((await response.json()).code).toBe('identity_assertion_rejected')
		expect(runLocalPersistentAuthCommitVerification).not.toHaveBeenCalled()
	})
})
