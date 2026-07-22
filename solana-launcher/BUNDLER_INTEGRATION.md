# Pump.fun Bundler Integration

This document describes the adapted Pump.fun bundler from the CLI tool to the web interface.

## Overview

The bundler allows coordinated token launches with multiple wallets:
- **Multi-wallet bundle buys** — simultaneous buys from multiple wallets
- **Jito MEV protection** — bundles sent via Jito relay
- **Wallet management** — generate/import bundler wallets
- **Simulation** — test bundles before execution

## Architecture

### Core Modules

| Module | Location | Purpose |
|--------|----------|---------|
| `lib/bundler/types.ts` | Types and interfaces | Bundle config, wallet types, results |
| `lib/bundler/wallet.ts` | WalletManager | Generate/import bundler wallets |
| `lib/bundler/jito.ts` | JitoBundleRelayer | Send bundles via Jito |
| `lib/bundler/pumpfun.ts` | Pump.fun helpers | Buy/sell instruction builders |
| `lib/bundler/idl.ts` | Pump.fun IDL | Program interface definitions |
| `hooks/useBundlerReal.ts` | React hook | Real transaction execution |

### API Routes

| Route | Purpose |
|-------|---------|
| `/api/bundler/create-token` | Build token creation transaction (Anchor) |
| `/api/bundler/buy` | Build buy transaction with bonding curve math |
| `/api/bundler/submit-tx` | Submit signed transaction to network |
| `/api/bundler/simulate` | Simulate bundle transactions |
| `/api/bundler/jito-status` | Check Jito bundle status |

### UI Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `BundlesPage` | `app/bundles/page.tsx` | Main bundler dashboard |
| `WalletManager` | `hooks/useBundler.ts` | Wallet generation/management |
| Bundle status card | `app/bundles/page.tsx` | Real-time bundle progress |

## Usage

### Real Token Launch

```typescript
import { useBundlerReal } from "@/hooks/useBundlerReal";

function MyComponent() {
  const { 
    generateLPWallet, 
    generateWallets, 
    launchWithBundle 
  } = useBundlerReal();

  // Launch token with bundle buys
  const result = await launchWithBundle(
    { name: "My Token", symbol: "MTK", description: "Test" },
    [0.1, 0.1, 0.1, 0.1] // SOL per wallet
  );
  // result.mint = newly created token mint

  const handleGenerate = () => {
    generateWallets(4); // Generate 4 bundler wallets
  };

  return (
    <div>
      {wallets.map(wallet => (
        <div key={wallet.keypair.publicKey.toBase58()}>
          {wallet.label}: {wallet.keypair.publicKey.toBase58()}
        </div>
      ))}
    </div>
  );
}
```

### Create Bundle Configuration

```typescript
const { createBundleConfig } = useBundler();

const config = createBundleConfig(
  lpWallet,        // Creator wallet
  tokenMetadata,   // Token metadata
  [0.1, 0.1, 0.1, 0.1], // SOL amounts per wallet
  0.00002,         // Priority fee
  0.0002           // Jito tip
);
```

### Execute Bundle

```typescript
const { simulateBundle, executeBundle } = useBundler();

// First simulate
const simResult = await simulateBundle(config);

// Then execute
const result = await executeBundle(config);
```

## Jito Regions

| Region | Endpoint |
|--------|----------|
| Frankfurt | `frankfurt.mainnet.block-engine.jito.wtf` |
| New York | `ny.mainnet.block-engine.jito.wtf` |
| Tokyo | `tokyo.mainnet.block-engine.jito.wtf` |

## Security Notes

1. **Wallet keys** are stored in memory only (not persisted to storage)
2. **Private keys** should never be logged or exposed to client
3. **Production** should use secure key management (AWS KMS, etc.)
4. **RPC endpoints** should be authenticated and rate-limited

## Real Transactions

Bundler now creates **real on-chain transactions** via server API:

1. **Client** generates wallets (LP + bundlers)
2. **Client** requests transaction from server API
3. **Server** builds transaction with Anchor (PDA derivation, bonding curve math)
4. **Client** signs transaction with wallet keypairs
5. **Client** submits signed transaction to network
6. **Server** confirms transaction and returns result

### Bonding Curve Math

Buy price calculated using constant product formula:
```
k = virtualSolReserves * virtualTokenReserves
tokensOut = virtualTokenReserves - (k / (virtualSolReserves + solAmount))
```

Default Pump.fun params:
- Virtual SOL reserves: 30 SOL
- Virtual token reserves: 1,073,000,000 tokens
- Fee: 1% (100 basis points)

## Comparison with CLI Version

| Feature | CLI | Web |
|---------|-----|-----|
| Interactive menu | ✅ | ✅ (tabs) |
| Wallet generation | ✅ | ✅ |
| Bundle buys | ✅ | ✅ Real transactions |
| Token creation | ✅ | ✅ Real transactions |
| SOL distribution | ✅ | ⚠️ Manual funding |
| Jito bundles | ✅ | ✅ Server-side submit |
| LUT management | ✅ | ❌ Not implemented |
| Holder wallets | ✅ | ❌ Not implemented |
| Bonding curve math | ✅ | ✅ Server-side |
| Anchor integration | ✅ | ✅ Full IDL |

## Test Environment

Use `/bundler-test` page for testing:
- Visual wallet management
- Token launch form
- Real-time chart from Solana Tracker
- Progress tracking
- Launch history

See `BUNDLER_TEST.md` for details.

## Environment Variables

```env
# Required for bundler
NEXT_PUBLIC_HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Optional: Jito configuration
JITO_REGION=frankfurt
JITO_FEE=0.0002
```

## Known Limitations

1. **Pump.fun SDK** — Full Anchor program integration needs IDL
2. **LUT (Lookup Tables)** — Not implemented in web version
3. **Automatic SOL distribution** — Manual funding required
4. **Holder wallet management** — Not implemented
5. **Token metadata upload** — IPFS upload needs implementation

## Future Enhancements

- [ ] Full Pump.fun SDK integration with Anchor
- [ ] Automatic SOL distribution via airdrop
- [ ] Token metadata IPFS upload
- [ ] LUT creation and management
- [ ] Holder wallet support
- [ ] Bundle templates (quick configs)
- [ ] P&L tracking across launches
