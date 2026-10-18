/**
 * Unified account budget for browser and XActions transports.
 * The initial pickAccount() reservation pays for the first read/navigation;
 * every further browser scroll or HTTP request reserves a weighted operation
 * atomically under the same PostgreSQL account lease.
 *
 * Conservative: scrolling is charged even if X served cached DOM. This avoids
 * accidentally bypassing quotas when X changes its fetch implementation.
 */
export {
  createHttpQuotaGate as createCollectorQuotaGate,
  reserveAdditionalHttpRequest as reserveAdditionalCollectorRequest,
  httpQuotaWaitMs as collectorQuotaWaitMs,
  HttpAccountQuotaError as CollectorQuotaError,
  HttpAccountLeaseError as CollectorAccountLeaseError,
} from "../../xactions/account-http-quota";
