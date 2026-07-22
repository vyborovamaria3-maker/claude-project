import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCsrf } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/async-handler";
import { createWalletChallenge, verifyWalletSignature } from "../security/wallet";

const router = Router();
router.use(requireAuth, requireCsrf);

const publicKeySchema = z.object({ publicKey: z.string().min(32) });
const linkSchema = publicKeySchema.extend({ signature: z.string().min(32) });

router.post(
  "/challenge",
  asyncHandler(async (req, res) => {
    const { publicKey } = publicKeySchema.parse(req.body);
    const challenge = await createWalletChallenge(req.session!.userId, publicKey);
    res.json(challenge);
  })
);

router.post(
  "/link",
  asyncHandler(async (req, res) => {
    const { publicKey, signature } = linkSchema.parse(req.body);
    await verifyWalletSignature(req.session!.userId, publicKey, signature);

    await prisma.wallet.updateMany({
      where: { userId: req.session!.userId },
      data: { isPrimary: false }
    });

    const wallet = await prisma.wallet.upsert({
      where: { publicKey },
      update: { userId: req.session!.userId, isPrimary: true },
      create: { userId: req.session!.userId, publicKey, isPrimary: true }
    });

    res.json({ wallet });
  })
);

router.delete(
  "/",
  asyncHandler(async (req, res) => {
    await prisma.wallet.deleteMany({ where: { userId: req.session!.userId } });
    res.json({ ok: true });
  })
);

export default router;
