import { Router } from "express";
import { BillingPeriod, PaymentCurrency, SubscriptionTier } from "@prisma/client";
import { z } from "zod";
import { requireAuth, requireCsrf } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/async-handler";
import { confirmPayment, getSubscriptionStatus, initiatePayment } from "../services/subscription.service";

const router = Router();
router.use(requireAuth, requireCsrf);

const initiateSchema = z.object({
  planId: z.nativeEnum(SubscriptionTier),
  period: z.nativeEnum(BillingPeriod).default(BillingPeriod.MONTHLY),
  currency: z.nativeEnum(PaymentCurrency).default(PaymentCurrency.SOL)
});

const confirmSchema = z.object({
  paymentId: z.string().uuid(),
  signature: z.string().min(32)
});

router.post(
  "/initiate",
  asyncHandler(async (req, res) => {
    const body = initiateSchema.parse(req.body);
    const payment = await initiatePayment({ userId: req.session!.userId, ...body });
    res.status(201).json({ payment });
  })
);

router.post(
  "/confirm",
  asyncHandler(async (req, res) => {
    const { paymentId, signature } = confirmSchema.parse(req.body);
    const payment = await confirmPayment(req.session!.userId, paymentId, signature);
    res.json({ payment });
  })
);

router.get(
  "/status",
  asyncHandler(async (req, res) => {
    const subscription = await getSubscriptionStatus(req.session!.userId);
    res.json({ subscription });
  })
);

router.get(
  "/payments",
  asyncHandler(async (req, res) => {
    const payments = await prisma.paymentTransaction.findMany({
      where: { userId: req.session!.userId },
      include: { plan: true },
      orderBy: { createdAt: "desc" },
      take: 50
    });
    res.json({ payments });
  })
);

export default router;
