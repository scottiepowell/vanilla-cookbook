import { redirect } from '@sveltejs/kit'

/** @type {import('./$types').PageServerLoad} */
export function load({ locals }) {
	if (!locals.user) throw redirect(303, '/login')
	return { userPublicRecipes: locals.user.publicRecipes ?? false }
}
