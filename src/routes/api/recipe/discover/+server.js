import { env } from '$env/dynamic/private'
import { json } from '@sveltejs/kit'
import { requireAuth } from '$lib/server/authHelpers'
import { prisma } from '$lib/server/prisma'
import { rateLimitCheck } from '$lib/server/rateLimit'
import {
	parseIngredients,
	findVisibleRecipes,
	rankRecipes
} from '$lib/server/ingredientDiscovery.js'

const hosts = new Set(['www.foodnetwork.com', 'www.budgetbytes.com', 'www.loveandlemons.com'])
const respond = (body, status = 200) =>
	json(body, { status, headers: { 'cache-control': 'no-store' } })

/** Search own/public Cookbook recipes and a reviewed public link catalog. */
export async function POST({ request, locals, fetch }) {
	const user = requireAuth(locals)
	if (!rateLimitCheck(`recipe:discover:${user.userId}`, { limit: 30, windowMs: 60_000 }).ok)
		return respond({ message: 'Please wait before searching again.' }, 429)
	let ingredients
	try {
		ingredients = parseIngredients((await request.json())?.ingredients)
	} catch {
		return respond(
			{ message: 'Enter up to 12 ingredients, separated by commas or new lines.' },
			400
		)
	}
	let local
	try {
		local = await findVisibleRecipes(prisma, user, ingredients)
	} catch {
		return respond({ message: 'Cookbook search is temporarily unavailable.' }, 503)
	}
	let publicRecipes = [],
		publicStatus = 'unavailable',
		catalogCount = 0
	if (env.AI_SIDECAR_ENABLED === 'true' && env.AI_SIDECAR_URL && env.AI_SIDECAR_OPERATOR_TOKEN) {
		try {
			// Fetch the same public catalog for everyone. No query, IDs or saved data leave core.
			const response = await fetch(`${env.AI_SIDECAR_URL.replace(/\/$/, '')}/ai/public-recipes`, {
				headers: { 'x-ai-operator-token': env.AI_SIDECAR_OPERATOR_TOKEN },
				signal: AbortSignal.timeout(5000)
			})
			const body = await response.json()
			if (
				!response.ok ||
				body.scope !== 'curated_catalog' ||
				!Array.isArray(body.recipes) ||
				body.recipes.length > 100
			)
				throw new Error('Invalid catalog')
			const catalog = body.recipes.filter((item) => {
				try {
					const url = new URL(item.url)
					return (
						url.protocol === 'https:' &&
						hosts.has(url.hostname) &&
						!url.username &&
						!url.password &&
						['uid', 'name', 'ingredients', 'source', 'verified'].every(
							(key) => typeof item[key] === 'string' && item[key].length < 2000
						)
					)
				} catch {
					return false
				}
			})
			catalogCount = catalog.length
			publicRecipes = rankRecipes(catalog, ingredients).slice(0, 20)
			publicStatus = 'ok'
		} catch {
			/* Keep canonical search usable during a sidecar outage. */
		}
	}
	return respond({
		ingredients,
		cookbook: local.recipes.map((recipe) => ({
			...recipe,
			url: `/recipe/${encodeURIComponent(recipe.uid)}/view/`
		})),
		truncated: local.truncated,
		publicRecipes,
		publicStatus,
		catalogCount
	})
}
