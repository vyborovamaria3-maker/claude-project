import { Router } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/async-handler";

const router = Router();

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { monthlySol: "asc" }
    });
    res.json({ plans });
  })
);

export default router;
