// data-tag: lib.bundler.jito
// Jito bundle relay integration adapted from pumpfun-bundler

import {
  VersionedTransaction,
  Connection,
} from "@solana/web3.js";
import axios from "axios";

const JITO_ENDPOINTS = {
  frankfurt: "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles",
  ny: "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles",
  tokyo: "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles",
};

export interface JitoConfig {
  endpoint: string;
  feeLamports: number;
}

export class JitoBundleRelayer {
  private endpoint: string;

  constructor(region: keyof typeof JITO_ENDPOINTS = "frankfurt") {
    this.endpoint = JITO_ENDPOINTS[region];
  }

  /**
   * Send bundle via Jito relay
   */
  async sendBundle(txs: VersionedTransaction[]): Promise<string | null> {
    try {
      const serializedTxs = txs.map((tx) =>
        Buffer.from(tx.serialize()).toString("base64")
      );

      const { data } = await axios.post(
        this.endpoint,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [serializedTxs],
        },
        {
          headers: { "Content-Type": "application/json" },
          timeout: 60_000,
        }
      );

      const bundleId = data?.result as string | undefined;
      if (bundleId) {
        console.log("Bundle sent:", bundleId);
        return bundleId;
      }
      return null;
    } catch (err) {
      console.error("Jito bundle error:", err);
      return null;
    }
  }

  /**
   * Get bundle status
   */
  async getBundleStatus(bundleId: string): Promise<unknown> {
    try {
      const { data } = await axios.post(
        this.endpoint,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getBundleStatuses",
          params: [[bundleId]],
        },
        {
          headers: { "Content-Type": "application/json" },
          timeout: 30_000,
        }
      );
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Simulate bundle
   */
  async simulateBundle(txs: VersionedTransaction[]): Promise<unknown> {
    try {
      const serializedTxs = txs.map((tx) =>
        Buffer.from(tx.serialize()).toString("base64")
      );

      const { data } = await axios.post(
        this.endpoint,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "simulateBundle",
          params: [{ encodedTransactions: serializedTxs }],
        },
        {
          headers: { "Content-Type": "application/json" },
          timeout: 60_000,
        }
      );
      return data;
    } catch (err) {
      console.error("Simulation error:", err);
      return null;
    }
  }
}

// Default instance
export const jitoRelayer = new JitoBundleRelayer();
