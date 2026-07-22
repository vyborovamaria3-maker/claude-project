import { Router } from "express";
import { SubscriptionStatus } from "@prisma/client";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/async-handler";
import { AppError } from "../utils/errors";

const router = Router();
router.use(requireAuth);

router.get(
  "/wallet-analytics",
  asyncHandler(async (req, res) => {
    const subscription = await prisma.subscription.findFirst({
      where: {
        userId: req.session!.userId,
        status: SubscriptionStatus.ACTIVE,
        endsAt: { gt: new Date() }
      },
      include: { plan: true }
    });

    if (!subscription) {
      throw new AppError(402, "Active subscription required", "SUBSCRIPTION_REQUIRED");
    }

    const wallet = await prisma.wallet.findFirst({
      where: { userId: req.session!.userId, isPrimary: true }
    });

    res.json({
      wallet: wallet?.publicKey ?? null,
      balanceSol: 12.42,
      transactions: [
        { signature: "demo-3G7x...aPq9", type: "swap", amountSol: -0.23, timestamp: "2026-06-21T09:22:10Z" },
        { signature: "demo-7BwR...P1x2", type: "receive", amountSol: 2.75, timestamp: "2026-06-22T16:41:33Z" },
        { signature: "demo-91aK...Lm8s", type: "stake", amountSol: -5, timestamp: "2026-06-24T11:08:03Z" }
      ],
      riskFlags: ["No suspicious drains detected", "High activity token accounts: 4"],
      subscription
    });
  })
);

export default router;
