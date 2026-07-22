// Thin API layer. Currently returns mock data; swap each function body with a fetch call later.
import {
  trending,
  dashboardStats,
  realizedPnl,
  pnlChartData,
  masterWallet,
  currentUser,
} from "./mockData";

export async function fetchTrending() {
  // TODO: return (await fetch("/api/trending")).json();
  return trending;
}

export async function fetchDashboardStats() {
  // TODO: return (await fetch("/api/dashboard/stats")).json();
  return dashboardStats;
}

export async function fetchRealizedPnl() {
  // TODO: return (await fetch("/api/pnl/realized?range=30d")).json();
  return realizedPnl;
}

export async function fetchPnlChart() {
  // TODO: return (await fetch("/api/pnl/chart?range=30d")).json();
  return pnlChartData;
}

export async function fetchMasterWallet() {
  // TODO: return (await fetch("/api/wallet/master")).json();
  return masterWallet;
}

export async function fetchCurrentUser() {
  // TODO: return (await fetch("/api/me")).json();
  return currentUser;
}

// PumpPortal API for token creation with cashback option
// Based on: https://pumpportal.fun/creation/

interface TokenMetadata {
  name: string;
  symbol: string;
  uri: string; // IPFS URL
}

interface PumpPortalCreateParams {
  publicKey: string;
  action: "create";
  tokenMetadata: TokenMetadata;
  mint: string; // token contract address
  denominatedInSol: "true" | "false";
  amount: number; // dev buy amount
  slippage: number;
  priorityFee: number;
  pool: "pump" | "raydium" | "pump-amm" | "launchlab" | "raydium-cpmm" | "bonk" | "auto";
  cashback?: boolean; // Pump.fun cashback option - rewards go to traders instead of creator
}

interface PumpPortalLocalResponse {
  transaction: number[]; // serialized transaction bytes
}

interface PumpPortalLightningResponse {
  signature: string;
}

const PUMPPORTAL_BASE_URL = "https://pumpportal.fun/api";

/**
 * Get serialized transaction for local signing (token creation with cashback)
 * Endpoint: POST /api/trade-local
 * Docs: https://pumpportal.fun/local-trading-api/trading-api/
 */
export async function createTokenWithPumpPortalLocal(
  params: PumpPortalCreateParams,
  apiKey?: string
): Promise<PumpPortalLocalResponse> {
  const url = apiKey 
    ? `${PUMPPORTAL_BASE_URL}/trade?api-key=${apiKey}` 
    : `${PUMPPORTAL_BASE_URL}/trade-local`;
    
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    throw new Error(`PumpPortal API error: ${response.status} ${response.statusText}`);
  }

  // Local API returns serialized transaction bytes
  const arrayBuffer = await response.arrayBuffer();
  return { transaction: Array.from(new Uint8Array(arrayBuffer)) };
}

/**
 * Create token via Lightning API (auto-signed, requires API key)
 * Endpoint: POST /api/trade?api-key={key}
 * Docs: https://pumpportal.fun/trading-api/setup
 */
export async function createTokenWithPumpPortalLightning(
  params: PumpPortalCreateParams,
  apiKey: string
): Promise<PumpPortalLightningResponse> {
  if (!apiKey) {
    throw new Error("PumpPortal API key is required for Lightning transactions");
  }
  
  const url = `${PUMPPORTAL_BASE_URL}/trade?api-key=${apiKey}`;
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    throw new Error(`PumpPortal API error: ${response.status} ${response.statusText}`);
  }

  // Lightning API returns JSON with signature
  return await response.json();
}

/**
 * Upload metadata to IPFS (using Pinata)
 * Returns IPFS CID that can be used in tokenMetadata.uri
 */
export async function uploadToPinata(
  file: File,
  pinataJWT: string
): Promise<string> {
  const formData = new FormData();
  formData.append("network", "public");
  formData.append("file", file);

  const response = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pinataJWT}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Pinata upload error: ${response.status}`);
  }

  const data = await response.json();
  return `https://ipfs.io/ipfs/${data.data.cid}`;
}

export type { TokenMetadata, PumpPortalCreateParams, PumpPortalLocalResponse, PumpPortalLightningResponse };
