/** Bounded ingredient-name matching without sending canonical data to an LLM. */
const singular = (word) =>
	({ tomatoes: 'tomato', potatoes: 'potato', leaves: 'leaf' })[word] ||
	(word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)

export function normalizeIngredient(value) {
	return (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).map(singular).join(' ')
}

export function parseIngredients(text) {
	if (typeof text !== 'string' || text.length > 300) throw new Error('Enter up to 12 ingredients.')
	const items = [
		...new Set(
			text
				.split(/[,;\n]|\band\b/i)
				.map(normalizeIngredient)
				.filter(Boolean)
		)
	]
	if (!items.length || items.length > 12 || items.some((item) => item.length > 50))
		throw new Error('Enter up to 12 ingredients separated by commas or new lines.')
	return items
}

export function rankRecipes(recipes, ingredients) {
	return recipes
		.map((recipe) => {
			const words = ` ${normalizeIngredient(recipe.ingredients || '')} `
			const matched = ingredients.filter((item) => words.includes(` ${item} `))
			return {
				uid: recipe.uid,
				name: recipe.name,
				matched,
				missing: ingredients.filter((item) => !matched.includes(item)),
				match: matched.length === ingredients.length ? 'all' : 'partial',
				url: recipe.url,
				source: recipe.source,
				verified: recipe.verified
			}
		})
		.filter((recipe) => recipe.matched.length)
		.sort(
			(a, b) =>
				b.matched.length - a.matched.length ||
				a.name.localeCompare(b.name) ||
				a.uid.localeCompare(b.uid)
		)
}

export async function findVisibleRecipes(prisma, user, ingredients) {
	const where = {
		in_trash: false,
		...(user.isAdmin ? {} : { OR: [{ userId: user.userId }, { is_public: true }] })
	}
	const candidates = []
	let cursor
	// Bound memory and expose the search scope if a large collection exceeds it.
	while (candidates.length < 5000) {
		const page = await prisma.recipe.findMany({
			where,
			orderBy: { uid: 'asc' },
			take: 500,
			...(cursor ? { cursor: { uid: cursor }, skip: 1 } : {}),
			select: { uid: true, name: true, ingredients: true }
		})
		candidates.push(...page)
		if (page.length < 500)
			return { recipes: rankRecipes(candidates, ingredients).slice(0, 20), truncated: false }
		cursor = page.at(-1).uid
	}
	return { recipes: rankRecipes(candidates, ingredients).slice(0, 20), truncated: true }
}
