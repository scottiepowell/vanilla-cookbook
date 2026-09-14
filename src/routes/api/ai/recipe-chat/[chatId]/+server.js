import { json } from '@sveltejs/kit'
import { requireAuth } from '$lib/server/authHelpers'
import { deleteRecipeChat, getOwnedRecipeChat } from '$lib/server/aiRecipeChat'

export function DELETE({ locals, params }) {
	const user = requireAuth(locals)
	const session = getOwnedRecipeChat(params.chatId, user.userId)
	if (!session)
		return json(
			{ status: 'expired', message: 'This recipe chat already expired.' },
			{ status: 404 }
		)
	deleteRecipeChat(params.chatId)
	return json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } })
}
