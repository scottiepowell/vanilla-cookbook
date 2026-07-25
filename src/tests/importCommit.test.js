import { describe, expect, it, vi } from 'vitest'
import { commitRecipeImport } from '../lib/server/importCommit.js'

const user = { userId: 'synthetic-commit-user', username: 'synthetic', isAdmin: false }

function candidate(key = 'commit-fixture') {
	return {
		title: 'Local Commit Fixture',
		description: 'Synthetic reviewed candidate.',
		servings: 2,
		ingredients: ['1 cup beans', '1 pinch salt'],
		instructions: ['Warm the beans.', 'Season and serve.'],
		source: 'reviewed-local-fixture',
		source_url: 'https://example.test/local-commit-fixture',
		notes: 'Reviewed synthetic provenance.',
		idempotency_key: key,
		contract_version: 'cookbook-import-candidate.v1',
		schema_version: 'recipe.v1'
	}
}

class FixtureStore {
	constructor() {
		this.rows = []
		this.nextId = 1
		this.failCreate = false
		this.recipe = {
			findFirst: async ({ where }) => this.rows.find((row) => {
				if (where.userId && row.userId !== where.userId) return false
				if (where.name && row.name !== where.name) return false
				if (where.ingredients && row.ingredients !== where.ingredients) return false
				if (where.directions && row.directions !== where.directions) return false
				if (where.hash?.startsWith && !row.hash.startsWith(where.hash.startsWith)) return false
				return true
			}) || null,
			create: async ({ data }) => {
				if (this.failCreate) throw new Error('injected fixture create failure')
				const row = { uid: `synthetic-recipe-${this.nextId++}`, ...data }
				this.rows.push(row)
				return row
			}
		}
	}

	async $transaction(callback) {
		const before = this.rows.slice()
		try {
			return await callback(this)
		} catch (error) {
			this.rows = before
			throw error
		}
	}
}

describe('core-owned local commit adapter', () => {
	it('requires explicit confirmation before storage access', async () => {
		const store = new FixtureStore()
		const result = await commitRecipeImport({ candidate: candidate(), user, prisma: store })
		expect(result.status).toBe('confirmation_required')
		expect(store.rows).toHaveLength(0)
	})

	it('commits the first-scope mapping for the authenticated owner', async () => {
		const store = new FixtureStore()
		const result = await commitRecipeImport({ candidate: candidate(), user, prisma: store, confirmSave: true })
		expect(result.status).toBe('committed')
		expect(result.recipe_uid).toBe('synthetic-recipe-1')
		expect(store.rows[0]).toMatchObject({
		userId: user.userId,
		name: 'Local Commit Fixture',
		servings: '2',
		ingredients: '1 cup beans\n1 pinch salt',
		directions: '1. Warm the beans.\n2. Season and serve.',
		is_public: false
	})
	})

	it('rejects identity assertions, invalid candidates, and missing versions safely', async () => {
		const store = new FixtureStore()
		const identity = await commitRecipeImport({ candidate: { ...candidate(), userId: 'not-accepted' }, user, prisma: store, confirmSave: true })
		const invalid = await commitRecipeImport({ candidate: { ...candidate(), title: '', source_url: 'javascript:alert(1)' }, user, prisma: store, confirmSave: true })
		const version = await commitRecipeImport({ candidate: { ...candidate(), contract_version: 'old' }, user, prisma: store, confirmSave: true })
		expect(identity.code).toBe('adapter.identity_assertion_rejected')
		expect(invalid.status).toBe('invalid')
		expect(version.code).toBe('adapter.version_required')
		expect(JSON.stringify({ identity, invalid, version })).not.toMatch(/javascript|not-accepted|prisma|sqlite|stack|token|session/i)
		expect(store.rows).toHaveLength(0)
	})

	it('replays the same key, conflicts on changed payload, and blocks duplicates', async () => {
		const store = new FixtureStore()
		const first = await commitRecipeImport({ candidate: candidate('stable-key'), user, prisma: store, confirmSave: true })
		const replay = await commitRecipeImport({ candidate: candidate('stable-key'), user, prisma: store, confirmSave: true })
		const conflict = await commitRecipeImport({ candidate: { ...candidate('stable-key'), description: 'Changed candidate.' }, user, prisma: store, confirmSave: true })
		expect(first.recipe_uid).toBe(replay.recipe_uid)
		expect(replay.idempotency_status.state).toBe('replay')
		expect(conflict.status).toBe('conflict')
		expect(store.rows).toHaveLength(1)

		const duplicate = await commitRecipeImport({ candidate: candidate('different-key'), user, prisma: store, confirmSave: true })
		expect(duplicate.status).toBe('duplicate_review_required')
		expect(store.rows).toHaveLength(1)
	})

	it('rolls back an injected create failure and exposes no private storage details', async () => {
		const store = new FixtureStore()
		store.failCreate = true
		await expect(commitRecipeImport({ candidate: candidate('failure-key'), user, prisma: store, confirmSave: true })).rejects.toThrow('injected fixture create failure')
		expect(store.rows).toHaveLength(0)
	})
})
