import { describe, expect, it } from 'vitest'
import { localAuthFixtureGuard } from '../lib/server/localAuthFixture.js'

const valid = {
	NODE_ENV: 'development',
	RUN_LOCAL_DEV_AUTH_FIXTURE: '1',
	LOCAL_DEV_AUTH_FIXTURE_APPROVED: '1',
	SYNTHETIC_AUTH_FIXTURE: '1',
	VANILLA_COOKBOOK_IMAGE: 'local/vanilla-cookbook-adapter:0034c',
	COOKBOOK_TARGET_URL: 'http://127.0.0.1:3000/'
}

describe('local dev synthetic auth fixture guards', () => {
	it('fails closed by default', () => {
		expect(localAuthFixtureGuard({}).allowed).toBe(false)
	})

	it('accepts only the explicit synthetic local configuration', () => {
		expect(localAuthFixtureGuard(valid)).toEqual({ allowed: true, reasons: [] })
	})

	it('rejects production, exposed, deployment, and wrong-image contexts', () => {
		expect(localAuthFixtureGuard({ ...valid, NODE_ENV: 'production' }).allowed).toBe(false)
		expect(localAuthFixtureGuard({ ...valid, COOKBOOK_TARGET_URL: 'https://cookbook.roadmaps.link/' }).allowed).toBe(false)
		expect(localAuthFixtureGuard({ ...valid, GITHUB_ACTIONS: 'true' }).allowed).toBe(false)
		expect(localAuthFixtureGuard({ ...valid, VANILLA_COOKBOOK_IMAGE: 'jt196/vanilla-cookbook:stable' }).allowed).toBe(false)
	})
})
