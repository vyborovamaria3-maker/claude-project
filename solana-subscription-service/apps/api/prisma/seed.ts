import { PrismaClient } from "@prisma/client";
import { PLAN_DEFINITIONS } from "@solsub/shared";

const prisma = new PrismaClient();

async function main() {
  for (const plan of PLAN_DEFINITIONS) {
    await prisma.subscriptionPlan.upsert({
      where: { id: plan.code },
      update: {
        name: plan.name,
        description: plan.description,
        monthlySol: plan.monthlySol,
        yearlySol: plan.yearlySol,
        features: plan.features,
        isActive: true
      },
      create: {
        id: plan.code,
        name: plan.name,
        description: plan.description,
        monthlySol: plan.monthlySol,
        yearlySol: plan.yearlySol,
        features: plan.features,
        isActive: true
      }
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
