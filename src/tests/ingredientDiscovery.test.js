import { describe, expect, it, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import {
	parseIngredients,
	rankRecipes,
	findVisibleRecipes
} from '../lib/server/ingredientDiscovery.js'

describe('ingredient matching', () => {
	it('combines carrots, lettuce and onions, plural forms and duplicate input', () => {
		expect(parseIngredients('carrots, lettuce and onions\ncarrot')).toEqual([
			'carrot',
			'lettuce',
			'onion'
		])
		const recipes = rankRecipes(
			[
				{ uid: 'partial', name: 'Soup', ingredients: 'Carrots and red onions' },
				{ uid: 'all', name: 'Salad', ingredients: '2 carrots\nlettuce\n1 red onion' },
				{ uid: 'none', name: 'Rice', ingredients: 'rice milk' }
			],
			parseIngredients('carrots, lettuce, onions')
		)
		expect(recipes.map((r) => r.uid)).toEqual(['all', 'partial'])
		expect(recipes[0].match).toBe('all')
		expect(recipes[1].missing).toEqual(['lettuce'])
	})
	it('does not match substrings or titles and handles no matches', () => {
		expect(
			rankRecipes([{ uid: 'x', name: 'Egg salad', ingredients: 'eggplant' }], ['egg'])
		).toEqual([])
	})
	it.each(['', 'x'.repeat(301), null, Array.from({ length: 13 }, (_, i) => `food${i}`).join(',')])(
		'bounds input %s',
		(input) => {
			expect(() => parseIngredients(input)).toThrow()
		}
	)
})

describe('real SQLite visibility integration', () => {
	const prisma = new PrismaClient({
		adapter: new PrismaLibSql({ url: ':memory:' })
	})
	afterAll(async () => {
		await prisma.$disconnect()
	})
	it('isolates users, includes public recipes, excludes trash, and respects admin visibility', async () => {
		await prisma.$executeRawUnsafe(
			'CREATE TABLE Recipe (uid TEXT PRIMARY KEY, name TEXT NOT NULL, ingredients TEXT, userId TEXT, is_public BOOLEAN, in_trash BOOLEAN)'
		)
		for (const [uid, owner, isPublic, trash] of [
			['a', 'alice', false, false],
			['b', 'bob', false, false],
			['p', 'bob', true, false],
			['t', 'alice', true, true]
		]) {
			await prisma.$executeRawUnsafe(
				'INSERT INTO Recipe VALUES (?, ?, ?, ?, ?, ?)',
				uid,
				uid,
				'carrots lettuce onions',
				owner,
				isPublic,
				trash
			)
		}
		const query = parseIngredients('carrots, lettuce, onions')
		const alice = await findVisibleRecipes(prisma, { userId: 'alice' }, query)
		const bob = await findVisibleRecipes(prisma, { userId: 'bob' }, query)
		expect(alice.recipes.map((r) => r.uid)).toEqual(['a', 'p'])
		expect(bob.recipes.map((r) => r.uid)).toEqual(['b', 'p'])
		expect(
			(await findVisibleRecipes(prisma, { userId: 'alice', isAdmin: true }, query)).recipes.map(
				(r) => r.uid
			)
		).toEqual(['a', 'b', 'p'])
		expect(alice.truncated).toBe(false)
	})
})
