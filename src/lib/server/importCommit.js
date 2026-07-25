import { createHash } from 'node:crypto'
import { dryRunRecipeImport, IMPORT_CONTRACT_VERSION, RECIPE_SCHEMA_VERSION } from './importAdapter.js'

export const IMPORT_COMMIT_VERSION = '0033z'
const ADAPTER_HASH_PREFIX = 'cookbook-import:v1:'
const FORBIDDEN_IDENTITY_FIELDS = new Set(['userId', 'owner', 'session', 'cookie', 'token', 'auth'])

function digest(value) {
	return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function hasIdentityAssertion(candidate) {
	return candidate && typeof candidate === 'object' && Object.keys(candidate).some((key) => FORBIDDEN_IDENTITY_FIELDS.has(key))
}

function safeResult(status, extra = {}) {
	return {
		status,
		adapter_version: IMPORT_COMMIT_VERSION,
		contract_version: IMPORT_CONTRACT_VERSION,
		schema_version: RECIPE_SCHEMA_VERSION,
		...extra
	}
}

function commitMarker(userId, idempotencyKey, fingerprint) {
	return `${ADAPTER_HASH_PREFIX}${digest(`${userId}\u0000${idempotencyKey}`)}:${fingerprint}`
}

function markerPrefix(userId, idempotencyKey) {
	return `${ADAPTER_HASH_PREFIX}${digest(`${userId}\u0000${idempotencyKey}`)}:`
}

function markerFingerprint(hash) {
	return typeof hash === 'string' && hash.startsWith(ADAPTER_HASH_PREFIX) ? hash.slice(hash.lastIndexOf(':') + 1) : null
}

function recipeUrl(uid) {
	return `/recipe/${encodeURIComponent(uid)}/view`
}

function committedResult(recipe, state = 'committed') {
	return safeResult('committed', {
		recipe_uid: recipe.uid,
		recipe_url: recipeUrl(recipe.uid),
		idempotency_status: { state },
		next_action: 'open_the_local_recipe'
	})
}

/**
 * Persist one reviewed candidate inside the core application's transaction
 * boundary. The caller supplies the authenticated core user and Prisma-like
 * client so unit tests can use a fixture store without sessions or SQLite.
 */
export async function commitRecipeImport({ candidate, user, prisma, confirmSave = false }) {
	if (!confirmSave) return safeResult('confirmation_required', { error: 'Explicit confirmation is required before local save.', code: 'adapter.confirmation_required' })
	if (!prisma?.$transaction || !prisma.recipe) return safeResult('unavailable', { error: 'Core recipe storage is unavailable.', code: 'adapter.storage_unavailable' })
	if (!user || typeof user.userId !== 'string' || !user.userId.trim()) {
		return safeResult('unauthenticated', { error: 'An authenticated core user is required.', code: 'adapter.auth_required' })
	}
	if (hasIdentityAssertion(candidate)) {
		return safeResult('invalid', { error: 'Ownership comes from the authenticated core context.', code: 'adapter.identity_assertion_rejected' })
	}
	if (!candidate || candidate.contract_version !== IMPORT_CONTRACT_VERSION || candidate.schema_version !== RECIPE_SCHEMA_VERSION) {
		return safeResult('invalid', { error: 'A current dry-run contract and schema version are required.', code: 'adapter.version_required' })
	}

	const dryRun = dryRunRecipeImport({ candidate, user, idempotencyRegistry: new Map() })
	if (dryRun.status !== 'dry_run_ready') return safeResult('invalid', { field_errors: dryRun.field_errors, warnings: dryRun.warnings })
	const key = candidate.idempotency_key.trim()
	const fingerprint = dryRun.idempotency_status.fingerprint
	const prefix = markerPrefix(user.userId, key)
	const marker = commitMarker(user.userId, key, fingerprint)

	return prisma.$transaction(async (tx) => {
		const prior = await tx.recipe.findFirst({ where: { userId: user.userId, hash: { startsWith: prefix } }, orderBy: { created: 'asc' } })
		if (prior) {
			if (markerFingerprint(prior.hash) === fingerprint) return committedResult(prior, 'replay')
			return safeResult('conflict', {
				error: 'The idempotency key was already used for a different candidate.',
				code: 'adapter.idempotency_conflict',
				idempotency_status: { state: 'conflict' }
			})
		}

		const duplicate = await tx.recipe.findFirst({
			where: {
				userId: user.userId,
				name: dryRun.mapped_recipe_preview.name,
				ingredients: dryRun.mapped_recipe_preview.ingredients,
				directions: dryRun.mapped_recipe_preview.directions
			},
			select: { uid: true }
		})
		if (duplicate) {
			return safeResult('duplicate_review_required', {
				code: 'adapter.duplicate_review_required',
				duplicate_status: 'review_required',
				duplicate_recipe_uid: duplicate.uid,
				idempotency_status: { state: 'not_committed' }
			})
		}

		const preview = dryRun.mapped_recipe_preview
		const recipe = await tx.recipe.create({
			data: {
				userId: user.userId,
				name: preview.name,
				description: preview.description,
				servings: preview.servings,
				ingredients: preview.ingredients,
				directions: preview.directions,
				source: preview.source || null,
				source_url: preview.source_url || null,
				notes: preview.notes || null,
				hash: marker,
				created: new Date(),
				is_public: false
			}
		})
		return committedResult(recipe)
	})
}

export function containsCommitIdentityAssertion(candidate) {
	return hasIdentityAssertion(candidate)
}
