// data-tag: lib.bundler.idl
// Pump.fun Program IDL (simplified for bundler)

export const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const MPL_TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
export const FEE_RECIPIENT = "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM";

export const PUMP_FUN_IDL = {
  version: "0.1.0",
  name: "pump_fun",
  instructions: [
    {
      name: "create",
      accounts: [
        { name: "mint", isMut: true, isSigner: true },
        { name: "mintAuthority", isMut: false, isSigner: false },
        { name: "bondingCurve", isMut: true, isSigner: false },
        { name: "associatedBondingCurve", isMut: true, isSigner: false },
        { name: "associatedUser", isMut: true, isSigner: false },
        { name: "user", isMut: true, isSigner: true },
        { name: "systemProgram", isMut: false, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false },
        { name: "associatedTokenProgram", isMut: false, isSigner: false },
        { name: "metadataProgram", isMut: false, isSigner: false },
        { name: "metadata", isMut: true, isSigner: false },
        { name: "rent", isMut: false, isSigner: false },
        { name: "eventAuthority", isMut: false, isSigner: false },
        { name: "program", isMut: false, isSigner: false },
      ],
      args: [
        { name: "name", type: "string" },
        { name: "symbol", type: "string" },
        { name: "uri", type: "string" },
        { name: "creator", type: "publicKey" },
      ],
    },
    {
      name: "buy",
      accounts: [
        { name: "global", isMut: false, isSigner: false },
        { name: "feeRecipient", isMut: true, isSigner: false },
        { name: "mint", isMut: false, isSigner: false },
        { name: "bondingCurve", isMut: true, isSigner: false },
        { name: "associatedBondingCurve", isMut: true, isSigner: false },
        { name: "associatedUser", isMut: true, isSigner: false },
        { name: "user", isMut: true, isSigner: true },
        { name: "systemProgram", isMut: false, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false },
        { name: "rent", isMut: false, isSigner: false },
        { name: "eventAuthority", isMut: false, isSigner: false },
        { name: "program", isMut: false, isSigner: false },
      ],
      args: [
        { name: "amount", type: "u64" },
        { name: "maxSolCost", type: "u64" },
        { name: "slippageBps", type: "u64" },
      ],
    },
    {
      name: "sell",
      accounts: [
        { name: "global", isMut: false, isSigner: false },
        { name: "feeRecipient", isMut: true, isSigner: false },
        { name: "mint", isMut: false, isSigner: false },
        { name: "bondingCurve", isMut: true, isSigner: false },
        { name: "associatedBondingCurve", isMut: true, isSigner: false },
        { name: "associatedUser", isMut: true, isSigner: false },
        { name: "user", isMut: true, isSigner: true },
        { name: "systemProgram", isMut: false, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false },
        { name: "eventAuthority", isMut: false, isSigner: false },
        { name: "program", isMut: false, isSigner: false },
      ],
      args: [
        { name: "amount", type: "u64" },
        { name: "minSolOutput", type: "u64" },
        { name: "slippageBps", type: "u64" },
      ],
    },
  ],
  accounts: [
    {
      name: "Global",
      type: {
        kind: "struct",
        fields: [
          { name: "initialized", type: "bool" },
          { name: "authority", type: "publicKey" },
          { name: "feeRecipient", type: "publicKey" },
          { name: "initialVirtualTokenReserves", type: "u64" },
          { name: "initialVirtualSolReserves", type: "u64" },
          { name: "initialRealTokenReserves", type: "u64" },
          { name: "tokenTotalSupply", type: "u64" },
          { name: "feeBasisPoints", type: "u64" },
        ],
      },
    },
    {
      name: "BondingCurve",
      type: {
        kind: "struct",
        fields: [
          { name: "virtualTokenReserves", type: "u64" },
          { name: "virtualSolReserves", type: "u64" },
          { name: "realTokenReserves", type: "u64" },
          { name: "realSolReserves", type: "u64" },
          { name: "tokenTotalSupply", type: "u64" },
          { name: "complete", type: "bool" },
        ],
      },
    },
  ],
  events: [
    {
      name: "CreateEvent",
      fields: [
        { name: "name", type: "string", index: false },
        { name: "symbol", type: "string", index: false },
        { name: "uri", type: "string", index: false },
        { name: "mint", type: "publicKey", index: false },
        { name: "bondingCurve", type: "publicKey", index: false },
        { name: "creator", type: "publicKey", index: false },
      ],
    },
    {
      name: "TradeEvent",
      fields: [
        { name: "mint", type: "publicKey", index: false },
        { name: "solAmount", type: "u64", index: false },
        { name: "tokenAmount", type: "u64", index: false },
        { name: "isBuy", type: "bool", index: false },
        { name: "user", type: "publicKey", index: false },
        { name: "timestamp", type: "i64", index: false },
        { name: "virtualSolReserves", type: "u64", index: false },
        { name: "virtualTokenReserves", type: "u64", index: false },
        { name: "realSolReserves", type: "u64", index: false },
        { name: "realTokenReserves", type: "u64", index: false },
      ],
    },
    {
      name: "CompleteEvent",
      fields: [
        { name: "user", type: "publicKey", index: false },
        { name: "mint", type: "publicKey", index: false },
        { name: "bondingCurve", type: "publicKey", index: false },
        { name: "timestamp", type: "i64", index: false },
      ],
    },
  ],
  errors: [
    { code: 6000, name: "NotAuthorized", msg: "Not authorized" },
    { code: 6001, name: "AlreadyInitialized", msg: "Already initialized" },
    { code: 6002, name: "TooMuchSolRequired", msg: "Too much SOL required" },
    { code: 6003, name: "TooLittleSolReceived", msg: "Too little SOL received" },
    { code: 6004, name: "MintDoesNotMatchBondingCurve", msg: "Mint does not match bonding curve" },
    { code: 6005, name: "BondingCurveComplete", msg: "Bonding curve complete" },
    { code: 6006, name: "BondingCurveNotComplete", msg: "Bonding curve not complete" },
    { code: 6007, name: "NotCreator", msg: "Not creator" },
    { code: 6008, name: "InvalidFeeRecipient", msg: "Invalid fee recipient" },
  ],
} as const;

// Bonding curve constants
export const DEFAULT_VIRTUAL_TOKEN_RESERVES = 1073000000; // 1.073B tokens
export const DEFAULT_VIRTUAL_SOL_RESERVES = 30 * 1e9; // 30 SOL
export const DEFAULT_TOKEN_TOTAL_SUPPLY = 1000000000; // 1B tokens
export const DEFAULT_FEE_BASIS_POINTS = 100; // 1%
