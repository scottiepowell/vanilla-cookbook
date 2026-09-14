import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import PrismaClientPkg from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { dryRunRecipeImport } from '../src/lib/server/importAdapter.js'
import { commitRecipeImport } from '../src/lib/server/importCommit.js'
import { localAuthFixtureGuard } from '../src/lib/server/localAuthFixture.js'

const guard = localAuthFixtureGuard(process.env)
if (!guard.allowed) {
	console.error(`local synthetic auth fixture unavailable: ${guard.reasons.join(',')}`)
	process.exit(2)
}

const { PrismaClient } = PrismaClientPkg
const root = mkdtempSync(join(tmpdir(), 'cookbook-local-auth-fixture-'))
const databasePath = join(root, 'dev.sqlite')
const backupPath = join(root, 'dev.sqlite.backup')
const uploadsPath = join(root, 'uploads')
const uploadsBackupPath = join(root, 'uploads.backup')
const databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`
let prisma

function candidate(key) {
	return {
		title: 'Synthetic Local Auth Fixture',
		description: 'Bounded disposable verification candidate.',
		servings: 2,
		ingredients: ['1 cup beans', '1 pinch salt'],
		instructions: ['Warm the beans.', 'Season and serve.'],
		source: 'reviewed-local-fixture',
		source_url: 'https://example.test/local-auth-fixture',
		notes: 'Reviewed synthetic provenance.',
		idempotency_key: key,
		contract_version: 'cookbook-import-candidate.v1',
		schema_version: 'recipe.v1'
	}
}

async function restoreAndRemove() {
	try {
		if (prisma) await prisma.$disconnect()
		copyFileSync(backupPath, databasePath)
		cpSync(uploadsBackupPath, uploadsPath, { recursive: true, force: true })
		const restored = new PrismaClient({ adapter: new PrismaLibSql({ url: databaseUrl }) })
		const recipeCount = await restored.recipe.count()
		await restored.$disconnect()
		if (recipeCount !== 0) throw new Error('restore_failed')
		console.log('fixture phase=restore status=verified')
	} finally {
		try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
	}
}

try {
	mkdirSync(uploadsPath, { recursive: true })
	mkdirSync(uploadsBackupPath, { recursive: true })
	const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'corepack'
	const args = process.platform === 'win32'
		? ['/d', '/s', '/c', 'corepack pnpm prisma db push --force-reset']
		: ['pnpm', 'prisma', 'db', 'push', '--force-reset']
	execFileSync(command, args, { cwd: process.cwd(), stdio: 'ignore', env: { ...process.env, DATABASE_URL: databaseUrl } })
	copyFileSync(databasePath, backupPath)
	cpSync(uploadsPath, uploadsBackupPath, { recursive: true })
	prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: databaseUrl }) })
	const databaseUser = await prisma.authUser.create({
		data: { username: `synthetic-${Date.now()}`, email: `synthetic-${Date.now()}@example.test` }
	})
	const user = { userId: databaseUser.id, username: databaseUser.username, isAdmin: false }
	const firstCandidate = candidate('fixture-stable-key')
	const dryRun = dryRunRecipeImport({ candidate: firstCandidate, user, idempotencyRegistry: new Map() })
	if (dryRun.status !== 'dry_run_ready') throw new Error('dry_run_failed')
	console.log('fixture phase=dry_run status=ready')
	const first = await commitRecipeImport({ candidate: firstCandidate, user, prisma, confirmSave: true })
	if (first.status !== 'committed') throw new Error('commit_failed')
	const stored = await prisma.recipe.findUnique({ where: { uid: first.recipe_uid }, select: { uid: true, userId: true, categories: true, photos: true, embedding: true } })
	if (!stored || stored.userId !== user.userId || stored.categories.length !== 0 || stored.photos.length !== 0 || stored.embedding !== null) throw new Error('read_after_write_failed')
	console.log(`fixture phase=commit status=committed recipe_uid=${first.recipe_uid}`)
	const replay = await commitRecipeImport({ candidate: firstCandidate, user, prisma, confirmSave: true })
	const conflict = await commitRecipeImport({ candidate: { ...firstCandidate, description: 'Changed.' }, user, prisma, confirmSave: true })
	const duplicate = await commitRecipeImport({ candidate: candidate('fixture-different-key'), user, prisma, confirmSave: true })
	if (replay.recipe_uid !== first.recipe_uid || replay.idempotency_status.state !== 'replay' || conflict.status !== 'conflict' || duplicate.status !== 'duplicate_review_required') throw new Error('idempotency_or_duplicate_failed')
	console.log(`fixture phase=replay status=${replay.idempotency_status.state}`)
	console.log(`fixture phase=conflict status=${conflict.status}`)
	console.log(`fixture phase=duplicate status=${duplicate.status}`)
	const beforeFailure = await prisma.recipe.count()
	let failureObserved = false
	try {
		await commitRecipeImport({ candidate: candidate('fixture-invalid-owner'), user: { userId: 'missing-synthetic-owner' }, prisma, confirmSave: true })
	} catch {
		failureObserved = true
	}
	if (!failureObserved) throw new Error('failure_not_injected')
	if (await prisma.recipe.count() !== beforeFailure) throw new Error('rollback_failed')
	console.log('fixture phase=rollback status=verified')
} catch {
	console.error('local synthetic auth fixture failed: safe verification failure')
	process.exitCode = 1
} finally {
	await restoreAndRemove()
}
