import { lucia } from 'lucia'
import { sveltekit } from 'lucia/middleware'
import { describe, expect, it } from 'vitest'
import {
	MOCK_ISSUER,
	mockOidcSessionFixtureGuard,
	runMockOidcSessionFixture,
	validateMockOidcClaims
} from '../lib/server/mockOidcSessionFixture.js'

function makeAuthStore() {
	const users = new Map()
	const sessions = new Map()
	const keys = new Map()
	return {
		getUser: async (id) => users.get(id) ?? null,
		setUser: async (user) => users.set(user.id, user),
		updateUser: async () => {},
		deleteUser: async (id) => users.delete(id),
		getKey: async (id) => keys.get(id) ?? null,
		getKeysByUserId: async (userId) => [...keys.values()].filter((key) => key.user_id === userId),
		setKey: async (key) => keys.set(key.id, key),
		updateKey: async () => {},
		deleteKey: async (id) => keys.delete(id),
		deleteKeysByUserId: async (userId) => {
			for (const [id, key] of keys) if (key.user_id === userId) keys.delete(id)
		},
		getSession: async (id) => sessions.get(id) ?? null,
		getSessionsByUserId: async (userId) => [...sessions.values()].filter((session) => session.user_id === userId),
		setSession: async (session) => sessions.set(session.id, session),
		updateSession: async (id, partial) => sessions.set(id, { ...sessions.get(id), ...partial }),
		deleteSession: async (id) => sessions.delete(id),
		deleteSessionsByUserId: async (userId) => {
			for (const [id, session] of sessions) if (session.user_id === userId) sessions.delete(id)
		},
		userCount: () => users.size,
		sessionCount: () => sessions.size
	}
}

function makeCookieJar() {
	const values = new Map()
	return {
		get: (key) => values.get(key),
		set: (key, value) => value ? values.set(key, value) : values.delete(key),
		delete: (key) => values.delete(key),
		keys: () => [...values.keys()]
	}
}

function makeIdentityStore(createCoreUser) {
	const users = new Map()
	const links = new Map()
	let nextId = 1
	return {
		findByProviderSubject: async (providerId, subject) => links.get(`${providerId}:${subject}`) ?? null,
		findByVerifiedEmail: async (email) => [...users.values()].find((user) => user.email === email) ?? null,
		createAuthUser: async ({ email, displayName }) => {
			const id = `core-user-${nextId++}`
			const coreUser = await createCoreUser({ id, email, displayName })
			const user = { id: coreUser.userId, email }
			users.set(user.id, user)
			return user
		},
		createProviderLink: async ({ providerId, providerUserId, userId }) => links.set(`${providerId}:${providerUserId}`, { userId })
	}
}

const env = {
	NODE_ENV: 'development',
	RUN_LOCAL_MOCK_OIDC_SESSION: '1',
	LOCAL_MOCK_OIDC_SESSION_APPROVED: '1',
	SYNTHETIC_AUTH_FIXTURE: '1',
	VANILLA_COOKBOOK_IMAGE: 'local/vanilla-cookbook-adapter:0034k',
	COOKBOOK_TARGET_URL: 'http://127.0.0.1:3000/'
}

const claims = {
	iss: MOCK_ISSUER,
	sub: 'synthetic-subject-1',
	email: 'synthetic-user@example.test',
	email_verified: true,
	name: 'Synthetic Local User'
}

const candidate = {
	title: 'Synthetic Session Recipe',
	idempotency_key: 'mock-session-recipe-1',
	contract_version: 'cookbook-import-candidate.v1',
	schema_version: 'recipe.v1'
}

describe('core-owned mock OIDC real session fixture', () => {
	it('fails closed unless explicit local gates are present', () => {
		expect(mockOidcSessionFixtureGuard({}).allowed).toBe(false)
		expect(mockOidcSessionFixtureGuard(env)).toEqual({ allowed: true, reasons: [] })
		for (const change of [
			{ NODE_ENV: 'production' },
			{ COOKBOOK_TARGET_URL: 'https://cookbook.roadmaps.link/' },
			{ CI: 'true' },
			{ GOOGLE_CLIENT_SECRET: 'must-not-exist' },
			{ OIDC_STORAGE_SCOPES: 'drive.file' }
		]) expect(mockOidcSessionFixtureGuard({ ...env, ...change }).allowed).toBe(false)
	})

	it('validates synthetic claims without token or session material', () => {
		expect(validateMockOidcClaims(claims)).toMatchObject({ status: 'accepted', subject: 'synthetic-subject-1' })
		expect(validateMockOidcClaims({ ...claims, iss: 'https://evil.example' }).code).toBe('issuer_rejected')
		expect(validateMockOidcClaims({ ...claims, email_verified: false }).status).toBe('review_required')
		expect(validateMockOidcClaims({ ...claims, access_token: 'nope' }).code).toBe('unsupported_claim')
	})

	it('runs real Lucia session creation, validation, core ownership, commit, and logout', async () => {
		const adapter = makeAuthStore()
		const auth = lucia({ adapter: () => adapter, env: 'DEV', middleware: sveltekit(), sessionCookie: { attributes: { secure: false, sameSite: 'lax', path: '/' } } })
		const cookieJar = makeCookieJar()
		const identityStore = makeIdentityStore(async ({ id, email }) => auth.createUser({ userId: id, key: null, attributes: { username: id, email } }))
		const commits = []
		const result = await runMockOidcSessionFixture({
			env,
			approved: true,
			claims,
			auth,
			identityStore,
			cookieJar,
			candidate,
			commitService: async ({ candidate: reviewedCandidate, user }) => {
				commits.push({ reviewedCandidate, user })
				return { status: 'committed', recipe_uid: 'opaque-recipe-1', idempotency_status: { state: 'new' } }
			}
		})
		expect(result).toMatchObject({ status: 'verified', link_status: 'created', authenticated_user: 'core_context_verified', save_status: 'committed', logout_status: 'invalidated' })
		expect(result).not.toHaveProperty('cookie')
		expect(commits[0].user.userId).toBe('core-user-1')
		expect(commits[0].reviewedCandidate).toEqual(candidate)
		expect(adapter.userCount()).toBe(1)
		expect(adapter.sessionCount()).toBe(0)
		expect(cookieJar.keys().length).toBe(0)
	})

	it('replays account linking and rejects the sidecar identity boundary', async () => {
		const adapter = makeAuthStore()
		const auth = lucia({ adapter: () => adapter, env: 'DEV', middleware: sveltekit() })
		const identityStore = makeIdentityStore(async ({ id, email }) => auth.createUser({ userId: id, key: null, attributes: { username: id, email } }))
		const first = { ...candidate, idempotency_key: 'replay-1' }
		const run = (input) => runMockOidcSessionFixture({ env, approved: true, claims, auth, identityStore, cookieJar: makeCookieJar(), candidate: input, commitService: async () => ({ status: 'duplicate_review_required' }) })
		expect((await run(first)).link_status).toBe('created')
		expect((await run(first)).link_status).toBe('replay')
		expect((await run({ ...first, session: 'forbidden' })).code).toBe('identity_assertion_rejected')
	})
})
