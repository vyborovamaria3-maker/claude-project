/**
 * Configuration for protocols, tokens, and addresses
 * 
 * WHY: Using multiple protocols is essential for anti-detect. Sybil filters look for
 * repetitive patterns. Each wallet interacting with 4-5 different protocols looks
 * like a real user exploring DeFi, not a bot farming airdrops.
 */

export const CONFIG = {
  // RPC with fallback - using multiple endpoints prevents IP tracking
  RPC_URLS: [
    process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
    "https://solana-api.projectserum.com",
    "https://rpc.ankr.com/solana",
  ],

  // Token mints - interacting with popular tokens looks natural
  TOKENS: {
    SOL: "So11111111111111111111111111111111111111112", // Wrapped SOL
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    ORCA: "orcaEKTdK7LKz57VaAYr9Q2Lo8vvM5EqQJ9e5ETvr9L",
    JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  },

  // Program IDs for lending protocols
  LENDING: {
    SOLEND: {
      programId: "So1endDq2ZVxX2ePp9UmjU7YVZKGnBZbBv5E6J5nXo",
      markets: {
        main: "4dS4qChEmP7CYIGZr9r7q1B7Ga9dMDL1H6qFzH8WfR4X",
      },
    },
    MARGINFI: {
      programId: "MFv2hWf31Z9kbWpzowX3AYKFV5K2JVgxdzJgShwPHUt",
    },
  },

  // Staking protocols
  STAKING: {
    MARINADE: {
      programId: "MarBmsSgKXdrM1h5HgNFPZsSXwj5gZSnM5XJ8NU9qrP",
      mSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    },
    JITO: {
      programId: "Jito4iNfY6LyjtJ2AfzR56Tb8zd3RjE5tFJvYSNuk1U",
      jitoSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6bVeZ9T4",
    },
    LIDO: {
      programId: "CrX7kMhLC3cSsXmjdS8dum6ywnRYYHy5N7DgtV8JRRVb",
      stSOL: "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARo",
    },
  },

  // DEX and AMM
  DEX: {
    JUPITER: {
      apiBase: "https://quote-api.jup.ag/v6",
      // Random slippage between 0.5% and 3% - real users don't use fixed slippage
      slippageBps: () => Math.floor(Math.random() * 250) + 50, // 0.5% - 3.0%
    },
    RAYDIUM: {
      programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    },
    ORCA: {
      programId: "9W959Dqne1fH3xRz2tT7Pm1wJbX1L7NPhoAZC7vErzM9",
    },
  },

  // NFT Marketplaces
  NFT: {
    MAGIC_EDEN: {
      apiBase: "https://api-mainnet.magiceden.dev/v2",
      // Cheap NFT collections for "natural" purchases
      cheapCollections: [
        "Degods",      // Sometimes has cheap listings
        "SMB_Gen2",    // Solana Monkey Business
        "CetsOnCreck",
        "okay_bears",
      ],
    },
    TENSOR: {
      apiBase: "https://api.tensor.so",
    },
  },

  // Bridge protocols - using bridges creates cross-chain activity
  BRIDGE: {
    WORMHOLE: {
      programId: "worm2ZoGByTLjH59Xb8JorHnSJpWqWjRqfXNmcaN7uv",
      // Supported chains for "diversification"
      supportedChains: ["ethereum", "bsc", "polygon", "avalanche"],
    },
    MAYAN: {
      // Mayan Finance - swap and bridge in one, good for hiding traces
      programId: "mayanSoL1ce5Y1U7xG6zQW1L3U5b5U5z5L5U5b5U5z5L",
    },
  },

  // Funding sources - different sources prevent traceability
  FUNDING: {
    // Minimum and maximum funding amounts with random decimals
    // WHY: Round numbers (1.0, 0.5) are bot-like. 1.0234 SOL looks human.
    MIN_FUND_SOL: 0.05,
    MAX_FUND_SOL: 0.5,
    
    // Random sleep before first action (3-14 days in seconds)
    MIN_SLEEP_DAYS: 3,
    MAX_SLEEP_DAYS: 14,
  },

  // Error simulation config
  // WHY: Real users make mistakes. Failed transactions add authenticity.
  ERROR_SIMULATION: {
    ENABLED: true,
    PROBABILITY: 0.08, // 8% chance of "human error"
    TYPES: [
      "insufficient_balance",    // Try to spend more than have
      "slippage_exceeded",       // Set slippage too low
      "invalid_amount",          // Wrong decimal places
      "rejected_by_user",        // Simulate manual rejection
    ],
  },
};

// Action weights for randomization
// WHY: Different probability weights make each wallet unique
export const ACTION_WEIGHTS = {
  SWAP: 40,      // Most common action
  STAKE: 25,     // Long-term holder behavior
  LEND: 15,      // Advanced DeFi user
  NFT: 10,       // Retail user behavior
  BRIDGE: 5,     // Power user (less common)
  IDLE: 5,       // Sometimes do nothing (very human)
};

export type ActionType = keyof typeof ACTION_WEIGHTS;
