import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runLocalAuthCommitVerification } = vi.hoisted(() => ({ runLocalAuthCommitVerification: vi.fn() }))
vi.mock('../lib/server/localAuthCommitVerification.js', () => ({
	runLocalAuthCommitVerification,
	hasLocalTransportIdentityAssertion: (candidate) => candidate && Object.hasOwn(candidate, 'userId')
}))

import { POST } from '../routes/api/adapter/dev-only/recipes/import-candidate/verify-local-commit/+server.js'

const candidate = {
	title: 'Transport Fixture',
	description: 'Reviewed local fixture.',
	servings: 2,
	ingredients: ['1 cup beans'],
	instructions: ['Warm the beans.'],
	source_url: 'https://example.test/fixture',
	notes: 'Reviewed fixture.',
	idempotency_key: 'transport-fixture',
	contract_version: 'cookbook-import-candidate.v1',
	schema_version: 'recipe.v1'
}

function request(body) {
	return { json: vi.fn().mockResolvedValue(body) }
}

describe('core local synthetic commit route', () => {
	beforeEach(() => vi.clearAllMocks())

	it('requires explicit confirmation and passes only candidate/approval to the core service', async () => {
		runLocalAuthCommitVerification.mockResolvedValueOnce({ status: 'unavailable', code: 'explicit_confirmation_required' })
		const response = await POST({ request: request({ candidate }) })
		expect(response.status).toBe(400)
		expect(runLocalAuthCommitVerification).toHaveBeenCalledWith({ candidate, approved: false, env: process.env })
	})

	it('returns a safe verified envelope', async () => {
		runLocalAuthCommitVerification.mockResolvedValueOnce({ status: 'verified', recipe_uid: 'opaque-local-uid', replay_status: 'replay' })
		const response = await POST({ request: request({ candidate, approve_local_write: true }) })
		const body = await response.json()
		expect(response.status).toBe(200)
		expect(body).toEqual({ status: 'verified', recipe_uid: 'opaque-local-uid', replay_status: 'replay' })
		expect(response.headers.get('set-cookie')).toBeNull()
	})

	it('rejects sidecar identity claims before the core service', async () => {
		const response = await POST({ request: request({ candidate: { ...candidate, userId: 'sidecar-user' }, approve_local_write: true }) })
		expect(response.status).toBe(400)
		expect((await response.json()).code).toBe('identity_assertion_rejected')
		expect(runLocalAuthCommitVerification).not.toHaveBeenCalled()
	})
})
