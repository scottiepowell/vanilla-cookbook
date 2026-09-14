import { createHash } from 'node:crypto'

export const IMPORT_ADAPTER_VERSION = '0033x'
export const IMPORT_CONTRACT_VERSION = 'cookbook-import-candidate.v1'
export const RECIPE_SCHEMA_VERSION = 'recipe.v1'

const ALLOWED_FIELDS = new Set([
	'title',
	'name',
	'description',
	'servings',
	'ingredients',
	'instructions',
	'directions',
	'source',
	'source_url',
	'notes',
	'provenance',
	'idempotency_key',
	'contract_version',
	'schema_version'
])

const MAX_TITLE_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 20_000
const MAX_LINE_LENGTH = 1_000
const MAX_NOTES_LENGTH = 1_000
const MAX_SOURCE_LENGTH = 200

function normalizeString(value) {
	return typeof value === 'string' ? value.trim() : ''
}

function normalizeLines(value, field, errors) {
	if (!Array.isArray(value) || value.length === 0) {
		errors.push({ field, code: 'required_array', message: `${field} must contain at least one item.` })
		return []
	}

	const lines = value.map((item, index) => {
		if (typeof item !== 'string' || !item.trim()) {
			errors.push({
				field: `${field}[${index}]`,
				code: 'required_text',
				message: `${field} items must be non-empty text.`
			})
			return ''
		}
		const line = item.trim()
		if (line.length > MAX_LINE_LENGTH) {
			errors.push({
				field: `${field}[${index}]`,
				code: 'too_long',
				message: `${field} items must be at most ${MAX_LINE_LENGTH} characters.`
			})
		}
		return line
	})

	return lines.filter(Boolean)
}

function normalizeServings(value, errors) {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return String(value)
	}
	const text = normalizeString(value)
	if (!text || text.length > 100) {
		errors.push({ field: 'servings', code: 'required_text', message: 'servings must be bounded text.' })
	}
	return text
}

function validateSourceUrl(value, errors) {
	if (value === undefined || value === null || value === '') return ''
	const text = normalizeString(value)
	try {
		const parsed = new URL(text)
		if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
			throw new Error('unsafe')
		}
		return parsed.toString()
	} catch {
		errors.push({
			field: 'source_url',
			code: 'unsafe_url',
			message: 'source_url must be an http or https URL without credentials.'
		})
		return ''
	}
}

function stableFingerprint(value) {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
}

function getIdempotencyStatus(key, fingerprint, registry) {
	if (!registry) return { state: 'not_recorded', fingerprint }
	const previous = registry.get(key)
	if (!previous) {
		registry.set(key, fingerprint)
		return { state: 'new', fingerprint }
	}
	if (previous === fingerprint) return { state: 'replay', fingerprint }
	return { state: 'conflict', fingerprint }
}

/**
 * Map and validate a reviewed candidate without importing Prisma, filesystem,
 * uploads, network clients, or provider code. The optional registry and
 * duplicate fingerprints are test/local-operation inputs, never database
 * reads or writes.
 */
export function dryRunRecipeImport({ candidate, user, idempotencyRegistry, duplicateFingerprints = [] }) {
	const fieldErrors = []
	const warnings = []

	if (!user || typeof user.userId !== 'string' || !user.userId.trim()) {
		fieldErrors.push({ field: 'owner', code: 'authenticated_user_required', message: 'An authenticated core user is required.' })
	}
	if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
		return buildResult({ fieldErrors: [{ field: 'candidate', code: 'invalid_object', message: 'Candidate must be an object.' }], warnings })
	}

	const unknownFields = Object.keys(candidate).filter((key) => !ALLOWED_FIELDS.has(key))
	if (unknownFields.length) {
		fieldErrors.push({ field: 'candidate', code: 'unknown_fields', message: 'Candidate contains unsupported fields.' })
	}

	if (candidate.contract_version && candidate.contract_version !== IMPORT_CONTRACT_VERSION) {
		fieldErrors.push({ field: 'contract_version', code: 'version_mismatch', message: 'Unsupported import contract version.' })
	}
	if (candidate.schema_version && candidate.schema_version !== RECIPE_SCHEMA_VERSION) {
		fieldErrors.push({ field: 'schema_version', code: 'version_mismatch', message: 'Unsupported recipe schema version.' })
	}

	const title = normalizeString(candidate.title || candidate.name)
	if (!title) fieldErrors.push({ field: 'title', code: 'required_text', message: 'title is required.' })
	if (title.length > MAX_TITLE_LENGTH) fieldErrors.push({ field: 'title', code: 'too_long', message: `title must be at most ${MAX_TITLE_LENGTH} characters.` })

	const description = normalizeString(candidate.description)
	if (description.length > MAX_DESCRIPTION_LENGTH) fieldErrors.push({ field: 'description', code: 'too_long', message: 'description exceeds the bounded length.' })

	const ingredients = normalizeLines(candidate.ingredients, 'ingredients', fieldErrors)
	const instructions = normalizeLines(candidate.instructions || candidate.directions, 'instructions', fieldErrors)
	const servings = normalizeServings(candidate.servings, fieldErrors)
	const source = normalizeString(candidate.source)
	if (source.length > MAX_SOURCE_LENGTH) fieldErrors.push({ field: 'source', code: 'too_long', message: 'source exceeds the bounded length.' })
	const sourceUrl = validateSourceUrl(candidate.source_url, fieldErrors)
	const notes = normalizeString(candidate.notes || candidate.provenance)
	if (notes.length > MAX_NOTES_LENGTH) fieldErrors.push({ field: 'notes', code: 'too_long', message: 'notes exceed the bounded length.' })

	const idempotencyKey = normalizeString(candidate.idempotency_key)
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(idempotencyKey)) {
		fieldErrors.push({ field: 'idempotency_key', code: 'invalid_key', message: 'idempotency_key must be bounded safe text.' })
	}

	const mappedRecipePreview = {
		name: title,
		description,
		servings,
		ingredients: ingredients.join('\n'),
		directions: instructions.map((line, index) => `${index + 1}. ${line}`).join('\n'),
		source: source,
		source_url: sourceUrl,
		notes,
		categories: [],
		media: [],
		embeddings: false
	}

	const ownerScope = user?.userId ? stableFingerprint({ owner: user.userId }) : 'anonymous'
	const candidateFingerprint = stableFingerprint({
		contract_version: IMPORT_CONTRACT_VERSION,
		owner_scope: ownerScope,
		name: title.toLocaleLowerCase(),
		ingredients: ingredients.map((line) => line.toLocaleLowerCase())
	})
	const idempotencyFingerprint = stableFingerprint({
		contract_version: IMPORT_CONTRACT_VERSION,
		owner_scope: ownerScope,
		mapped_recipe_preview: mappedRecipePreview
	})
	const idempotencyStatus = getIdempotencyStatus(idempotencyKey, idempotencyFingerprint, idempotencyRegistry)
	const duplicate = duplicateFingerprints.includes(candidateFingerprint)
	if (duplicate) warnings.push({ code: 'duplicate_candidate', message: 'A matching fixture fingerprint requires review before any future commit.' })
	if (idempotencyStatus.state === 'conflict') {
		fieldErrors.push({ field: 'idempotency_key', code: 'conflict', message: 'idempotency_key was previously used for a different candidate.' })
	}

	return buildResult({
		fieldErrors,
		warnings,
		mappedRecipePreview: fieldErrors.length ? null : mappedRecipePreview,
		fingerprint: candidateFingerprint,
		idempotencyStatus,
		duplicateStatus: duplicate ? 'review_required' : 'no_fixture_match'
	})
}

function buildResult({ fieldErrors, warnings, mappedRecipePreview = null, fingerprint = null, idempotencyStatus = { state: 'not_recorded', fingerprint: null }, duplicateStatus = 'not_checked' }) {
	const valid = fieldErrors.length === 0
	return {
		status: valid ? 'dry_run_ready' : 'invalid',
		adapter_version: IMPORT_ADAPTER_VERSION,
		contract_version: IMPORT_CONTRACT_VERSION,
		schema_version: RECIPE_SCHEMA_VERSION,
		mapped_recipe_preview: mappedRecipePreview,
		field_errors: fieldErrors,
		warnings,
		duplicate_status: duplicateStatus,
		idempotency_status: idempotencyStatus,
		candidate_fingerprint: fingerprint,
		next_action: valid ? 'review_then_use_a_separately_approved_commit_boundary' : 'correct_field_errors_and_retry'
	}
}

export function createDryRunRegistry() {
	return new Map()
}
