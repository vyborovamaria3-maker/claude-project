import { getAvailableAccount, markUsed } from "./repository";
import { logger } from "../core/logger";

export async function acquireAccount() {
  const account = await getAvailableAccount();

  if (!account) {
    logger.warn("no available x accounts");
    return null;
  }

  await markUsed(account.name);

  logger.info("account acquired", { name: account.name });

  return account;
}
