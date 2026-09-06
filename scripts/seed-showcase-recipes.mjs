import PrismaClientPkg from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

import { seedRecipes } from '../src/lib/utils/seed/seedHelpers.js'

const { PrismaClient } = PrismaClientPkg
const adapter = new PrismaLibSql({
	url: process.env.DATABASE_URL || 'file:./prisma/db/dev.sqlite'
})
const prisma = new PrismaClient({ adapter })

try {
	let targetUser = await prisma.authUser.findFirst({
		where: { isAdmin: true },
		select: { id: true }
	})

	if (!targetUser) {
		const users = await prisma.authUser.findMany({ select: { id: true }, take: 2 })
		if (users.length === 1) targetUser = users[0]
	}

	if (!targetUser) {
		console.error('A unique target account is not available for sample recipe seeding.')
		process.exitCode = 1
	} else {
		const result = await seedRecipes(targetUser.id, prisma, { processPhotos: false })
		console.log(
			`Sample recipe seed complete: created=${result.created}, skipped=${result.skipped}, failed=${result.failed}`
		)
		if (result.failed > 0) process.exitCode = 1
	}
} finally {
	await prisma.$disconnect()
}
