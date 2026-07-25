import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PrismaClientPkg from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { commitRecipeImport } from '../lib/server/importCommit.js'

const runIntegration = process.env.RUN_LOCAL_AUTH_COMMIT_DB === '1'
const describeIntegration = runIntegration ? describe : describe.skip
const { PrismaClient } = PrismaClientPkg
let tempRoot
let prisma
let user
let databaseUrl
let databasePath
let backupPath

function cleanupTempRoot() {
	if (!tempRoot) return
	try {
		rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
	} catch {
		// The Windows SQLite handle can remain locked until the worker exits.
	}
}

process.once('exit', cleanupTempRoot)

function candidate(key = 'sqlite-commit-fixture') {
	return {
		title: 'SQLite Local Commit Fixture',
		description: 'Synthetic disposable integration candidate.',
		servings: 2,
		ingredients: ['1 cup beans', '1 pinch salt'],
		instructions: ['Warm the beans.', 'Season and serve.'],
		source: 'reviewed-local-fixture',
		source_url: 'https://example.test/sqlite-commit-fixture',
		notes: 'Reviewed synthetic provenance.',
		idempotency_key: key,
		contract_version: 'cookbook-import-candidate.v1',
		schema_version: 'recipe.v1'
	}
}

describeIntegration('core-owned local SQLite commit verification', () => {
	beforeAll(async () => {
		tempRoot = mkdtempSync(join(tmpdir(), 'cookbook-adapter-'))
		databasePath = join(tempRoot, 'verification.sqlite')
		backupPath = join(tempRoot, 'verification.backup.sqlite')
		databaseUrl = `file:${databasePath.replaceAll('\\', '/')}`
		const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'corepack'
		const args = process.platform === 'win32'
			? ['/d', '/s', '/c', 'corepack pnpm prisma db push --force-reset']
			: ['pnpm', 'prisma', 'db', 'push', '--force-reset']
		execFileSync(command, args, {
			cwd: process.cwd(),
			stdio: 'ignore',
			env: { ...process.env, DATABASE_URL: databaseUrl }
		})
		copyFileSync(databasePath, backupPath)
		prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: databaseUrl }) })
		const databaseUser = await prisma.authUser.create({
			data: { username: `synthetic-${Date.now()}`, email: `synthetic-${Date.now()}@example.test` }
		})
		user = { userId: databaseUser.id, username: databaseUser.username, isAdmin: false }
	})

	afterAll(async () => {
		await prisma?.$disconnect()
		if (databasePath && backupPath) {
			copyFileSync(backupPath, databasePath)
			const restored = new PrismaClient({ adapter: new PrismaLibSql({ url: databaseUrl }) })
			expect(await restored.recipe.count()).toBe(0)
			await restored.$disconnect()
		}
		cleanupTempRoot()
	})

	it('creates one recipe, verifies safe read-after-write, and replays idempotently', async () => {
		const first = await commitRecipeImport({ candidate: candidate(), user, prisma, confirmSave: true })
		const replay = await commitRecipeImport({ candidate: candidate(), user, prisma, confirmSave: true })
		const stored = await prisma.recipe.findUnique({ where: { uid: first.recipe_uid }, select: { uid: true, userId: true, name: true, servings: true, categories: true, photos: true, embedding: true } })

		expect(first.status).toBe('committed')
		expect(first.recipe_uid).toBe(replay.recipe_uid)
		expect(replay.idempotency_status.state).toBe('replay')
		expect(stored).toMatchObject({ uid: first.recipe_uid, userId: user.userId, name: 'SQLite Local Commit Fixture', servings: '2' })
		expect(stored.categories).toHaveLength(0)
		expect(stored.photos).toHaveLength(0)
		expect(stored.embedding).toBeNull()
		expect(await prisma.recipe.count({ where: { userId: user.id } })).toBe(1)
	})

	it('conflicts on changed key payload and blocks duplicate content', async () => {
		const conflict = await commitRecipeImport({ candidate: { ...candidate(), description: 'Changed.' }, user, prisma, confirmSave: true })
		const duplicate = await commitRecipeImport({ candidate: candidate('different-key'), user, prisma, confirmSave: true })
		expect(conflict.status).toBe('conflict')
		expect(duplicate.status).toBe('duplicate_review_required')
		expect(await prisma.recipe.count({ where: { userId: user.id } })).toBe(1)
	})

	it('rolls back a foreign-owner create failure without adding a recipe', async () => {
		const before = await prisma.recipe.count()
		await expect(commitRecipeImport({ candidate: candidate('invalid-owner'), user: { userId: 'missing-synthetic-owner' }, prisma, confirmSave: true })).rejects.toBeTruthy()
		expect(await prisma.recipe.count()).toBe(before)
	})
})
