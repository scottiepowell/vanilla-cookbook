import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import PrismaClientPkg from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { dryRunRecipeImport } from './importAdapter.js'
import { commitRecipeImport } from './importCommit.js'

const { PrismaClient } = PrismaClientPkg
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const FORBIDDEN_FIELDS = new Set(['userId', 'owner', 'session', 'cookie', 'token', 'providerToken', 'oauthCode', 'storageGrant'])

function safeError(code) {
	return { status: 'unavailable', code, verification: 'not_run' }
}

function loopbackTarget(value) {
	try {
		const target = new URL(value)
		return target.protocol === 'http:' && LOOPBACK_HOSTS.has(target.hostname) && [3000, null].includes(target.port ? Number(target.port) : null)
	} catch {
		return false
	}
}

export function localTransportGuard(env = process.env) {
	const reasons = []
	if (env.NODE_ENV === 'production') reasons.push('production_mode')
	if (env.CI === 'true' || env.GITHUB_ACTIONS === 'true') reasons.push('ci_context')
	if (env.AWS_REGION || env.CLOUDFLARE_TUNNEL_TOKEN) reasons.push('deployment_context')
	if (env.RUN_LOCAL_DEV_AUTH_FIXTURE !== '1') reasons.push('fixture_disabled')
	if (env.LOCAL_DEV_AUTH_FIXTURE_APPROVED !== '1') reasons.push('approval_required')
	if (env.SYNTHETIC_AUTH_FIXTURE !== '1') reasons.push('synthetic_fixture_required')
	if (env.VANILLA_COOKBOOK_IMAGE !== 'local/vanilla-cookbook-adapter:0034f') reasons.push('approved_image_required')
	if (!loopbackTarget(env.COOKBOOK_TARGET_URL || '')) reasons.push('loopback_target_required')
	return { allowed: reasons.length === 0, reasons }
}

function hasForbiddenFields(value) {
	return value && typeof value === 'object' && Object.keys(value).some((key) => FORBIDDEN_FIELDS.has(key))
}

function safeEnvelope(extra = {}) {
	return {
		status: 'verified',
		verification: 'local_synthetic_auth',
		...extra
	}
}

function changedCandidate(candidate) {
	return { ...candidate, description: 'Changed reviewed fixture.' }
}

function duplicateCandidate(candidate) {
	return { ...candidate, idempotency_key: `${candidate.idempotency_key}-duplicate` }
}

/**
 * Run the proven 0034C sequence against a temporary schema-backed database.
 * This function never opens the application's configured database and returns
 * only statuses plus opaque IDs.
 */
export async function runLocalAuthCommitVerification({ candidate, approved = false, env = process.env } = {}) {
	const guard = localTransportGuard(env)
	if (!guard.allowed) return { ...safeError('local_transport_unavailable'), reasons: guard.reasons }
	if (approved !== true) return safeError('explicit_confirmation_required')
	if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return safeError('candidate_required')
	if (hasForbiddenFields(candidate)) return safeError('identity_assertion_rejected')
	if (typeof candidate.idempotency_key !== 'string' || !candidate.idempotency_key.trim()) return safeError('idempotency_key_required')

	const root = mkdtempSync(join(tmpdir(), 'cookbook-local-transport-'))
	const databasePath = join(root, 'dev.sqlite')
	const backupPath = join(root, 'dev.sqlite.backup')
	const uploadsPath = join(root, 'uploads')
	const uploadsBackupPath = join(root, 'uploads.backup')
	const databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`
	let prisma
	try {
		mkdirSync(uploadsPath, { recursive: true })
		mkdirSync(uploadsBackupPath, { recursive: true })
		const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'corepack'
		const args = process.platform === 'win32'
			? ['/d', '/s', '/c', 'corepack pnpm prisma db push --force-reset']
			: ['pnpm', 'prisma', 'db', 'push', '--force-reset']
		execFileSync(command, args, { cwd: process.cwd(), stdio: 'ignore', env: { ...env, DATABASE_URL: databaseUrl } })
		copyFileSync(databasePath, backupPath)
		cpSync(uploadsPath, uploadsBackupPath, { recursive: true })
		prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: databaseUrl }) })
		const databaseUser = await prisma.authUser.create({
			data: { username: `synthetic-transport-${Date.now()}`, email: `synthetic-transport-${Date.now()}@example.test` }
		})
		const user = { userId: databaseUser.id, username: databaseUser.username, isAdmin: false }
		const dryRun = dryRunRecipeImport({ candidate, user, idempotencyRegistry: new Map() })
		if (dryRun.status !== 'dry_run_ready') return safeError('dry_run_failed')
		const first = await commitRecipeImport({ candidate, user, prisma, confirmSave: true })
		if (first.status !== 'committed' || !first.recipe_uid) return safeError('commit_failed')
		const stored = await prisma.recipe.findUnique({ where: { uid: first.recipe_uid }, select: { uid: true, userId: true, categories: true, photos: true, embedding: true } })
		if (!stored || stored.userId !== user.userId || stored.categories.length !== 0 || stored.photos.length !== 0 || stored.embedding !== null) return safeError('read_after_write_failed')
		const replay = await commitRecipeImport({ candidate, user, prisma, confirmSave: true })
		const conflict = await commitRecipeImport({ candidate: changedCandidate(candidate), user, prisma, confirmSave: true })
		const duplicate = await commitRecipeImport({ candidate: duplicateCandidate(candidate), user, prisma, confirmSave: true })
		if (replay.recipe_uid !== first.recipe_uid || replay.idempotency_status?.state !== 'replay' || conflict.status !== 'conflict' || duplicate.status !== 'duplicate_review_required') return safeError('idempotency_or_duplicate_failed')
		const beforeFailure = await prisma.recipe.count()
		let rollback = 'not_verified'
		try {
			await commitRecipeImport({ candidate: duplicateCandidate({ ...candidate, idempotency_key: `${candidate.idempotency_key}-failure` }), user: { userId: 'missing-synthetic-owner' }, prisma, confirmSave: true })
		} catch {
			rollback = (await prisma.recipe.count()) === beforeFailure ? 'verified' : 'failed'
		}
		if (rollback !== 'verified') return safeError('rollback_failed')
		return safeEnvelope({
			recipe_uid: first.recipe_uid,
			recipe_url: first.recipe_url,
			commit_status: 'committed',
			read_after_write: 'verified',
			replay_status: replay.idempotency_status.state,
			conflict_status: conflict.status,
			duplicate_status: duplicate.status,
			rollback_status: rollback,
			content_scope: 'first_scope_no_categories_media_embeddings'
		})
	} catch {
		return safeError('safe_local_verification_failure')
	} finally {
		try {
			if (prisma) await prisma.$disconnect()
			if (backupPath && databasePath) copyFileSync(backupPath, databasePath)
			cpSync(uploadsBackupPath, uploadsPath, { recursive: true, force: true })
		} catch {
		}
		try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
	}
}

export function hasLocalTransportIdentityAssertion(candidate) {
	return hasForbiddenFields(candidate)
}
