import type { PoolClient } from "pg";
import {
  BlockchainAdapter,
  ChainTransaction,
  ChainWallet,
  SUPPORTED_CHAINS,
  SupportedChain,
  assertSupportedChain,
  normalizeAddress,
  normalizeTransactionHash,
} from "./chain-adapter";

export type ChainQueryable = Pick<PoolClient, "query">;

export class ChainNotRegisteredError extends Error {
  constructor(readonly chain: string) {
    super(`No blockchain adapter registered for chain ${JSON.stringify(chain)}`);
    this.name = "ChainNotRegisteredError";
  }
}

export class ChainRegistry {
  private readonly adapters = new Map<SupportedChain, BlockchainAdapter>();

  register(adapter: BlockchainAdapter): this {
    this.adapters.set(adapter.chain, adapter);
    return this;
  }

  unregister(chain: string): boolean {
    return this.adapters.delete(assertSupportedChain(chain));
  }

  has(chain: string): boolean {
    return this.adapters.has(chain as SupportedChain);
  }

  getAdapter(chain: string): BlockchainAdapter {
    const adapter = this.adapters.get(chain as SupportedChain);
    if (!adapter) throw new ChainNotRegisteredError(chain);
    return adapter;
  }

  registeredChains(): SupportedChain[] {
    return SUPPORTED_CHAINS.filter((chain) => this.adapters.has(chain));
  }

  supportedChains(): SupportedChain[] {
    return [...SUPPORTED_CHAINS];
  }
}

class DatabaseChainAdapter implements BlockchainAdapter {
  constructor(private readonly db: ChainQueryable, readonly chain: SupportedChain) {}

  private variants(value: string): string[] {
    const normalized =
      this.chain === "ethereum" || this.chain === "bitcoin"
        ? value.toLowerCase()
        : value;
    return [...new Set([value, normalized])];
  }

  async getTransaction(hash: string): Promise<ChainTransaction | null> {
    const variants = [...new Set([hash, normalizeTransactionHash(this.chain, hash)])];
    const result = await this.db.query<{
      hash: string;
      amount: string;
      timestamp: Date | null;
      raw_event_id: string;
      from_address: string | null;
      to_address: string | null;
      token_address: string | null;
    }>(
      `SELECT t.hash, t.amount::text AS amount, t.timestamp, t.raw_event_id,
              fe.external_id AS from_address, te.external_id AS to_address,
              tok.external_id AS token_address
       FROM ip_blockchain_transactions t
       LEFT JOIN ip_entities fe ON fe.id = t.from_entity
       LEFT JOIN ip_entities te ON te.id = t.to_entity
       LEFT JOIN ip_entities tok ON tok.id = t.token_entity
       WHERE t.chain = $1 AND t.hash = ANY($2::text[])`,
      [this.chain, variants],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      chain: this.chain,
      hash: row.hash,
      from: row.from_address ?? "",
      to: row.to_address ?? "",
      token: row.token_address,
      amount: row.amount,
      timestamp: row.timestamp,
      rawEventId: row.raw_event_id,
    };
  }

  async getWallet(address: string): Promise<ChainWallet | null> {
    const normalized = normalizeAddress(this.chain, address);
    const entities = await this.db.query<{ id: string; external_id: string }>(
      `SELECT id, external_id FROM ip_entities
       WHERE type = 'WALLET' AND platform = $1 AND external_id = ANY($2::text[])`,
      [this.chain, this.variants(address)],
    );
    const entity = entities.rows[0];
    if (!entity) return null;
    const last = await this.db.query<{ raw_event_id: string; timestamp: Date | null }>(
      `SELECT raw_event_id, timestamp FROM ip_blockchain_transactions
       WHERE chain = $1 AND (from_entity = $2 OR to_entity = $2)
       ORDER BY timestamp DESC NULLS LAST LIMIT 1`,
      [this.chain, entity.id],
    );
    return {
      chain: this.chain,
      address: entity.external_id || normalized,
      entityId: entity.id,
      balance: null,
      observedAt: last.rows[0]?.timestamp ?? null,
      rawEventId: last.rows[0]?.raw_event_id ?? null,
    };
  }

  async getBalance(address: string): Promise<string | null> {
    const wallet = await this.getWallet(address);
    return wallet?.balance ?? null;
  }
}

export function createDatabaseAdapter(db: ChainQueryable, chain: string): BlockchainAdapter {
  return new DatabaseChainAdapter(db, assertSupportedChain(chain));
}

export function createDefaultRegistry(db: ChainQueryable): ChainRegistry {
  const registry = new ChainRegistry();
  for (const chain of SUPPORTED_CHAINS) registry.register(createDatabaseAdapter(db, chain));
  return registry;
}
