import { describe, expect, it } from 'vitest'
import {
	createDryRunRegistry,
	dryRunRecipeImport,
	IMPORT_CONTRACT_VERSION,
	RECIPE_SCHEMA_VERSION
} from '$lib/server/importAdapter'

const user = { userId: 'synthetic-local-user', username: 'synthetic', isAdmin: false }
const candidate = {
	title: 'Local Dry-Run Soup',
	description: 'A reviewed fixture candidate.',
	servings: 4,
	ingredients: ['2 cups stock', '1 cup beans'],
	instructions: ['Combine ingredients.', 'Simmer until warm.'],
	source: 'reviewed-fixture',
	source_url: 'https://example.test/fixture',
	notes: 'Reviewed import provenance fixture.',
	idempotency_key: 'fixture-soup-1',
	contract_version: IMPORT_CONTRACT_VERSION,
	schema_version: RECIPE_SCHEMA_VERSION
}

describe('core-owned local import dry-run adapter', () => {
	it('maps a valid candidate without persistence', () => {
		const result = dryRunRecipeImport({ candidate, user, idempotencyRegistry: createDryRunRegistry() })

		expect(result.status).toBe('dry_run_ready')
		expect(result.mapped_recipe_preview).toMatchObject({
			name: 'Local Dry-Run Soup',
			servings: '4',
			ingredients: '2 cups stock\n1 cup beans',
			directions: '1. Combine ingredients.\n2. Simmer until warm.',
			categories: [],
			media: [],
			embeddings: false
		})
		expect(result.idempotency_status.state).toBe('new')
	})

	it('requires core user context and required fields', () => {
		const result = dryRunRecipeImport({ candidate: { ...candidate, title: '', ingredients: [], instructions: [] }, user: null })

		expect(result.status).toBe('invalid')
		expect(result.field_errors.map((item) => item.field)).toEqual(expect.arrayContaining(['owner', 'title', 'ingredients', 'instructions']))
	})

	it('rejects unsafe URLs and unknown fields without exposing values', () => {
		const result = dryRunRecipeImport({ candidate: { ...candidate, source_url: 'javascript:alert(1)', prompt: 'hidden' }, user })

		expect(result.status).toBe('invalid')
		expect(result.field_errors.map((item) => item.code)).toEqual(expect.arrayContaining(['unsafe_url', 'unknown_fields']))
		expect(JSON.stringify(result)).not.toContain('javascript')
		expect(JSON.stringify(result)).not.toContain('hidden')
	})

	it('returns safe version mismatch errors and excludes provider/media fields', () => {
		const result = dryRunRecipeImport({ candidate: { ...candidate, contract_version: 'old', image_url: 'https://example.test/image.jpg' }, user })

		expect(result.status).toBe('invalid')
		expect(result.field_errors.map((item) => item.code)).toEqual(expect.arrayContaining(['version_mismatch', 'unknown_fields']))
		expect(JSON.stringify(result)).not.toContain('image_url')
		expect(JSON.stringify(result)).not.toContain('provider')
	})

	it('reports duplicate fixture fingerprints without mutation', () => {
		const first = dryRunRecipeImport({ candidate, user })
		const result = dryRunRecipeImport({ candidate, user, duplicateFingerprints: [first.candidate_fingerprint] })

		expect(result.status).toBe('dry_run_ready')
		expect(result.duplicate_status).toBe('review_required')
		expect(result.warnings[0].code).toBe('duplicate_candidate')
	})

	it('supports replay and rejects same-key payload conflicts', () => {
		const registry = createDryRunRegistry()
		const first = dryRunRecipeImport({ candidate, user, idempotencyRegistry: registry })
		const replay = dryRunRecipeImport({ candidate, user, idempotencyRegistry: registry })
		const conflict = dryRunRecipeImport({ candidate: { ...candidate, description: 'different reviewed text' }, user, idempotencyRegistry: registry })

		expect(first.idempotency_status.state).toBe('new')
		expect(replay.idempotency_status.state).toBe('replay')
		expect(conflict.status).toBe('invalid')
		expect(conflict.idempotency_status.state).toBe('conflict')
	})

	it('does not require Prisma or mutate a store during dry-run', () => {
		const result = dryRunRecipeImport({ candidate, user })

		expect(result.next_action).toContain('commit_boundary')
		expect(JSON.stringify(result)).not.toMatch(/prisma|sqlite|cookie|token|session|stack/i)
	})
})
