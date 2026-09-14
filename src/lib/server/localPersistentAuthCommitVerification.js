import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { dryRunRecipeImport } from './importAdapter.js'
import { commitRecipeImport } from './importCommit.js'
import { prisma } from './prisma.js'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const APPROVED_IMAGE = 'local/vanilla-cookbook-adapter:0034g'
const SYNTHETIC_USERNAME = 'local-dev-synthetic'
const SYNTHETIC_EMAIL = 'local-dev-synthetic@example.test'
const FORBIDDEN_FIELDS = new Set(['userId', 'user_id', 'owner', 'session', 'cookie', 'token', 'providerToken', 'oauthCode', 'storageGrant', 'providerGrant'])

function safeError(code, reasons = undefined) {
	return reasons ? { status: 'unavailable', code, verification: 'not_run', reasons } : { status: 'unavailable', code, verification: 'not_run' }
}

function loopbackTarget(value) {
	try {
		const target = new URL(value)
		return target.protocol === 'http:' && LOOPBACK_HOSTS.has(target.hostname) && [3000, null].includes(target.port ? Number(target.port) : null) && !target.username && !target.password && !target.search && !target.hash
	} catch {
		return false
	}
}

export function localPersistentTransportGuard(env = process.env) {
	const reasons = []
	if (env.NODE_ENV === 'production') reasons.push('production_mode')
	if (env.CI === 'true' || env.GITHUB_ACTIONS === 'true') reasons.push('ci_context')
	if (env.AWS_REGION || env.CLOUDFLARE_TUNNEL_TOKEN || env.TUNNEL_TOKEN) reasons.push('deployment_context')
	if (env.RUN_LOCAL_PERSISTENT_AUTH_FIXTURE !== '1') reasons.push('fixture_disabled')
	if (env.LOCAL_PERSISTENT_AUTH_FIXTURE_APPROVED !== '1') reasons.push('approval_required')
	if (env.SYNTHETIC_AUTH_FIXTURE !== '1') reasons.push('synthetic_fixture_required')
	if (env.VANILLA_COOKBOOK_IMAGE !== APPROVED_IMAGE) reasons.push('approved_image_required')
	if (!loopbackTarget(env.COOKBOOK_TARGET_URL || '')) reasons.push('loopback_target_required')
	return { allowed: reasons.length === 0, reasons }
}

function hasForbiddenFields(value) {
	if (!value || typeof value !== 'object') return false
	if (Array.isArray(value)) return value.some(hasForbiddenFields)
	return Object.entries(value).some(([key, nested]) => FORBIDDEN_FIELDS.has(key) || hasForbiddenFields(nested))
}

function persistentPaths(env) {
	const configured = env.DATABASE_URL || 'file:./prisma/db/dev.sqlite'
	if (!configured.startsWith('file:')) return null
	const rawPath = configured.slice('file:'.length).split('?')[0]
	const databasePath = resolve(process.cwd(), rawPath)
	const databaseRoot = resolve(process.cwd(), 'prisma', 'db')
	const uploadsPath = resolve(process.cwd(), 'uploads')
	if (!databasePath.startsWith(databaseRoot + '\\') && !databasePath.startsWith(`${databaseRoot}/`)) return null
	if (databasePath !== resolve(databaseRoot, 'dev.sqlite')) return null
	if (!uploadsPath.startsWith(resolve(process.cwd(), 'uploads'))) return null
	return { databasePath, databaseRoot, uploadsPath }
}

function databaseFiles(databasePath) {
	return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
}

function backupRuntime(paths, backupRoot) {
	const databaseBackup = join(backupRoot, 'db')
	const uploadsBackup = join(backupRoot, 'uploads')
	mkdirSync(databaseBackup, { recursive: true })
	mkdirSync(uploadsBackup, { recursive: true })
	for (const file of databaseFiles(paths.databasePath)) {
		if (existsSync(file)) copyFileSync(file, join(databaseBackup, file.slice(paths.databaseRoot.length + 1)))
	}
	if (existsSync(paths.uploadsPath)) cpSync(paths.uploadsPath, uploadsBackup, { recursive: true })
	return { databaseBackup, uploadsBackup }
}

function restoreRuntime(paths, backup) {
	for (const file of databaseFiles(paths.databasePath)) {
		if (existsSync(file)) rmSync(file, { force: true })
	}
	for (const entry of readdirSync(backup.databaseBackup, { withFileTypes: true })) {
		if (entry.isFile()) copyFileSync(join(backup.databaseBackup, entry.name), join(paths.databaseRoot, entry.name))
	}
	if (existsSync(paths.uploadsPath)) rmSync(paths.uploadsPath, { recursive: true, force: true })
	if (existsSync(backup.uploadsBackup)) cpSync(backup.uploadsBackup, paths.uploadsPath, { recursive: true })
}

function safeEnvelope(extra = {}) {
	return { status: 'verified', verification: 'local_persistent_synthetic_auth', ...extra }
}

function changedCandidate(candidate) {
	return { ...candidate, description: 'Changed reviewed fixture.' }
}

function duplicateCandidate(candidate) {
	return { ...candidate, idempotency_key: `${candidate.idempotency_key}-duplicate` }
}

/**
 * Verify the core-owned adapter against the disposable app database.
 * The synthetic AuthUser is created and removed inside the core process; no
 * session, cookie, token, or sidecar identity is created or returned.
 */
export async function runLocalPersistentAuthCommitVerification({ candidate, approved = false, env = process.env, database = prisma } = {}) {
	const guard = localPersistentTransportGuard(env)
	if (!guard.allowed) return safeError('local_transport_unavailable', guard.reasons)
	if (approved !== true) return safeError('explicit_confirmation_required')
	if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return safeError('candidate_required')
	if (hasForbiddenFields(candidate)) return safeError('identity_assertion_rejected')
	if (typeof candidate.idempotency_key !== 'string' || !candidate.idempotency_key.trim()) return safeError('idempotency_key_required')

	const paths = persistentPaths(env)
	if (!paths || !existsSync(paths.databasePath)) return safeError('disposable_runtime_storage_required')
	const backupRoot = join(tmpdir(), 'cookbook-local-persistent-backup-') + Date.now()
	let backup
	let phase = 'backup'
	try {
		mkdirSync(backupRoot, { recursive: true })
		backup = backupRuntime(paths, backupRoot)
		phase = 'synthetic_user'
		const existing = await database.authUser.findUnique({ where: { username: SYNTHETIC_USERNAME } })
		const coreUser = existing || await database.authUser.create({ data: { username: SYNTHETIC_USERNAME, email: SYNTHETIC_EMAIL } })
		const user = { userId: coreUser.id, username: coreUser.username, isAdmin: false }
		phase = 'dry_run'
		const dryRun = dryRunRecipeImport({ candidate, user, idempotencyRegistry: new Map() })
		if (dryRun.status !== 'dry_run_ready') return safeError('dry_run_failed')
		phase = 'commit'
		const first = await commitRecipeImport({ candidate, user, prisma: database, confirmSave: true })
		if (first.status !== 'committed' || !first.recipe_uid) return safeError('commit_failed')
		phase = 'read_after_write'
		const stored = await database.recipe.findUnique({ where: { uid: first.recipe_uid }, select: { uid: true, userId: true, categories: true, photos: true, embedding: true } })
		if (!stored || stored.userId !== coreUser.id || stored.categories.length !== 0 || stored.photos.length !== 0 || stored.embedding !== null) return safeError('read_after_write_failed')
		phase = 'idempotency'
		const replay = await commitRecipeImport({ candidate, user, prisma: database, confirmSave: true })
		const conflict = await commitRecipeImport({ candidate: changedCandidate(candidate), user, prisma: database, confirmSave: true })
		const duplicate = await commitRecipeImport({ candidate: duplicateCandidate(candidate), user, prisma: database, confirmSave: true })
		if (replay.recipe_uid !== first.recipe_uid || replay.idempotency_status?.state !== 'replay' || conflict.status !== 'conflict' || duplicate.status !== 'duplicate_review_required') return safeError('idempotency_or_duplicate_failed')
		phase = 'rollback'
		const failure = await commitRecipeImport({ candidate: duplicateCandidate({ ...candidate, idempotency_key: `${candidate.idempotency_key}-failure` }), user: { userId: '' }, prisma: database, confirmSave: true })
		const rollback = failure.status === 'unauthenticated' ? 'verified' : 'failed'
		if (rollback !== 'verified') return { ...safeError('rollback_failed'), rollback_attempt_status: failure.status }
		return safeEnvelope({
			recipe_uid: first.recipe_uid,
			recipe_url: first.recipe_url,
			commit_status: 'committed',
			read_after_write: 'verified',
			replay_status: replay.idempotency_status.state,
			conflict_status: conflict.status,
			duplicate_status: duplicate.status,
			rollback_status: rollback,
			persistent_user_status: existing ? 'reused_synthetic_core_user' : 'created_synthetic_core_user',
			content_scope: 'first_scope_no_categories_media_embeddings'
		})
	} catch {
		return safeError(`persistent_${phase}_failed`)
	} finally {
		try {
			if (backup) restoreRuntime(paths, backup)
		} catch {
			// The safe envelope never exposes filesystem details.
		}
		try { rmSync(backupRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
	}
}

export function hasLocalPersistentIdentityAssertion(value) {
	return hasForbiddenFields(value)
}

export { APPROVED_IMAGE }
