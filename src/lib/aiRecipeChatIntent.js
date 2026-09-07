export function cleanAiPrompt(value) {
	return typeof value === 'string' ? value.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim() : ''
}

function normalized(value) {
	return cleanAiPrompt(value).replace(/\s+/g, ' ')
}

export function replacementConfirmationAnswer(value) {
	const answer = normalized(value)
		.toLowerCase()
		.replace(/[.!?]+$/g, '')
	if (
		/^(?:yes|yes,? i do|yep|yeah|start it|start over|start the new recipe|discard it)$/.test(answer)
	) {
		return 'confirm'
	}
	if (
		/^(?:no|no thanks|no thank you|keep it|keep this|keep the current recipe|cancel)$/.test(answer)
	) {
		return 'keep'
	}
	return null
}

export function explicitNewRecipeRequest(value) {
	const text = normalized(value)
	const match = text.match(/\b(?:start|begin|create|make)\s+(?:me\s+)?(?:a\s+)?new recipe\b/i)
	if (!match) return { explicit: false, idea: '' }
	const remainder = text
		.slice((match.index || 0) + match[0].length)
		.replace(/^\s*(?:for|with|using|of|that uses)\s+/i, '')
		.trim()
	return { explicit: true, idea: remainder }
}

export function proposedReplacementIdea(value) {
	const text = normalized(value)
	const explicit = explicitNewRecipeRequest(text)
	if (explicit.explicit && explicit.idea) return explicit.idea

	const replacementPatterns = [
		/\bswitch\s+(?:the\s+)?recipe(?:\s+and\s+(?:i\s+want\s+to\s+)?(?:do|make)|\s+to)\s+(.+)$/i,
		/\b(?:let.?s|actually)\s+go\s+with\s+(.+)$/i,
		/\bchange\s+this\s+to\s+(.+)$/i,
		/\binstead\s+(?:let.?s\s+)?(?:do|make)\s+(.+)$/i,
		/\bscrap\s+(?:that|this)(?:\s+recipe)?\s+and\s+make\s+(.+)$/i
	]
	for (const pattern of replacementPatterns) {
		const match = text.match(pattern)
		if (match) return match[1].trim()
	}

	const moreLike = text.match(/\bmore like\s+(.+)$/i)
	if (moreLike) {
		return moreLike[1]
			.replace(/^(?:a|an|the)\s+/i, '')
			.replace(/\s+dish[.!?]*$/i, '')
			.trim()
	}

	const stapleSwap = text.match(
		/\b(?:change|changing|replace|replacing|swap|swapping)(?:\s+out)?\s+(?:the\s+)?(?:pasta|rigatoni|spaghetti|noodles?|rice|tortillas?|bread|potatoes?)\s+(?:to|with|for)\s+(.+)$/i
	)
	if (stapleSwap) return `${stapleSwap[1].replace(/[.!?]+$/g, '').trim()} recipe`

	return text
}
