/**
 * Behavioral patterns for anti-detect simulation
 * 
 * WHY THIS MATTERS:
 * Sybil detection systems (Nansen, Chainalysis, LayerZero, etc.) use:
 * 1. Time-based clustering - wallets active at same times
 * 2. Amount patterns - identical or sequential amounts
 * 3. Action sequences - repetitive order of operations
 * 4. Gas patterns - similar priority fees
 * 
 * These patterns break all those signatures.
 */

import { CONFIG, ActionType, ACTION_WEIGHTS } from "./config";

// Human-like sleep schedules
// WHY: Bots run 24/7. Humans sleep. We simulate sleep 8-10 hours daily.
export const SLEEP_PATTERNS = {
  // Night sleep (most humans sleep at night)
  NIGHT_SLEEP: {
    START_HOUR: () => randomInt(22, 2), // 10 PM - 2 AM
    DURATION_HOURS: () => randomInt(6, 10), // 6-10 hours sleep
  },
  
  // Day breaks (humans take breaks)
  DAY_BREAK: {
    PROBABILITY: 0.3, // 30% chance of afternoon break
    DURATION_MINUTES: () => randomInt(30, 120), // 30min - 2hr break
  },
  
  // Weekend mode (less activity on weekends)
  WEEKEND_ACTIVITY_MULTIPLIER: () => randomFloat(0.3, 0.7),
};

// Random amount generator with human-like decimals
// WHY: Humans don't send exactly 0.1 SOL. They send 0.1034 or 0.0987.
export function generateHumanAmount(min: number, max: number): number {
  const base = randomFloat(min, max);
  // Add random decimal noise (4-7 decimal places)
  const noise = randomFloat(0.0001, 0.0009999);
  const result = base + noise;
  return Math.floor(result * 1e9) / 1e9; // Round to 9 decimals max (SOL precision)
}

// Time delays between actions
// WHY: Random intervals prevent time-based correlation attacks
export function generateDelay(): number {
  const minSeconds = parseInt(process.env.MIN_DELAY_SECONDS || "3600");
  const maxSeconds = parseInt(process.env.MAX_DELAY_SECONDS || "172800");
  
  // Logarithmic distribution - more shorter delays, fewer very long ones
  const random = Math.random();
  const logRandom = Math.pow(random, 2); // Bias toward shorter delays
  
  return Math.floor(minSeconds + logRandom * (maxSeconds - minSeconds));
}

// Random action selector with weighted probabilities
// WHY: Each wallet gets unique action sequence
export function selectRandomAction(): ActionType {
  const actions = Object.keys(ACTION_WEIGHTS) as ActionType[];
  const weights = Object.values(ACTION_WEIGHTS);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  
  let random = Math.random() * totalWeight;
  
  for (let i = 0; i < actions.length; i++) {
    random -= weights[i];
    if (random <= 0) {
      return actions[i];
    }
  }
  
  return "SWAP"; // Default fallback
}

// Generate sequence of actions for a wallet
// WHY: Each wallet has different "personality" - trader, holder, degen, etc.
export function generateActionSequence(walletIndex: number): ActionType[] {
  const sequenceLength = randomInt(5, 12); // 5-12 actions over the warmup period
  const sequence: ActionType[] = [];
  
  // Different "personality types" based on wallet index
  const personalities = [
    // Trader: mostly swaps
    { weights: { SWAP: 70, STAKE: 10, LEND: 10, NFT: 5, BRIDGE: 3, IDLE: 2 } },
    // Holder: mostly staking
    { weights: { SWAP: 20, STAKE: 60, LEND: 10, NFT: 5, BRIDGE: 3, IDLE: 2 } },
    // Degen: NFTs and swaps
    { weights: { SWAP: 50, STAKE: 10, LEND: 5, NFT: 30, BRIDGE: 3, IDLE: 2 } },
    // DeFi user: lending and staking
    { weights: { SWAP: 25, STAKE: 35, LEND: 30, NFT: 5, BRIDGE: 3, IDLE: 2 } },
    // Casual: mostly idle with occasional swaps
    { weights: { SWAP: 30, STAKE: 20, LEND: 5, NFT: 10, BRIDGE: 2, IDLE: 33 } },
  ];
  
  const personality = personalities[walletIndex % personalities.length];
  
  for (let i = 0; i < sequenceLength; i++) {
    const action = weightedRandom(personality.weights as Record<ActionType, number>);
    sequence.push(action);
  }
  
  return sequence;
}

// Helper functions
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function weightedRandom<T extends string>(weights: Record<T, number>): T {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let random = Math.random() * total;
  
  for (const [key, weight] of entries) {
    random -= weight;
    if (random <= 0) return key;
  }
  
  return entries[0][0];
}

// Generate funding amounts with anti-pattern logic
// WHY: Different amounts prevent "same transaction value" detection
export function generateFundingAmount(): number {
  const { MIN_FUND_SOL, MAX_FUND_SOL } = CONFIG.FUNDING;
  return generateHumanAmount(MIN_FUND_SOL, MAX_FUND_SOL);
}

// Random sleep before first action (simulating "new wallet sitting idle")
// WHY: Real users don't immediately use new wallets
export function generateInitialSleep(): number {
  const minDays = CONFIG.FUNDING.MIN_SLEEP_DAYS;
  const maxDays = CONFIG.FUNDING.MAX_SLEEP_DAYS;
  const days = randomInt(minDays, maxDays);
  return days * 24 * 60 * 60 * 1000; // Convert to milliseconds
}

// Priority fee randomization
// WHY: Same priority fees across wallets = instant bot detection
export function generatePriorityFee(): number {
  // Range: 5000 - 100000 microlamports (0.000005 - 0.0001 SOL)
  const baseFee = randomInt(5000, 50000);
  // Occasionally use higher fees (urgent transactions)
  const urgent = Math.random() < 0.2;
  return urgent ? baseFee * randomInt(2, 5) : baseFee;
}

// Randomize RPC endpoint selection
// WHY: Same IP hitting same RPC = easy to track
export function selectRandomRPC(): string {
  const rpcs = CONFIG.RPC_URLS;
  return rpcs[randomInt(0, rpcs.length - 1)];
}

// Simulate "mistakes" - failed transactions that look human
// WHY: Perfect execution is bot-like. Humans fail sometimes.
export function shouldSimulateError(): boolean {
  if (!CONFIG.ERROR_SIMULATION.ENABLED) return false;
  return Math.random() < CONFIG.ERROR_SIMULATION.PROBABILITY;
}

export function getRandomErrorType(): string {
  const errors = CONFIG.ERROR_SIMULATION.TYPES;
  return errors[randomInt(0, errors.length - 1)];
}

// Time-of-day activity modulation
// WHY: Humans are less active at 3 AM, more active at 8 PM
export function isActiveHour(): boolean {
  const hour = new Date().getHours();
  // Less activity 2 AM - 6 AM (sleep hours)
  if (hour >= 2 && hour <= 6) {
    return Math.random() < 0.1; // 10% chance of activity during sleep
  }
  // Peak hours 6 PM - 11 PM
  if (hour >= 18 && hour <= 23) {
    return Math.random() < 0.8; // 80% chance of activity
  }
  // Normal hours: 60% chance
  return Math.random() < 0.6;
}

// Generate "persona" description for logging
export function generatePersonaDescription(actionSequence: ActionType[]): string {
  const counts: Record<string, number> = {};
  actionSequence.forEach(a => { counts[a] = (counts[a] || 0) + 1; });
  
  const dominant = Object.entries(counts)
    .sort(([,a], [,b]) => b - a)[0][0];
  
  const personas: Record<string, string> = {
    SWAP: "Active Trader",
    STAKE: "Long-term Holder",
    LEND: "DeFi Power User",
    NFT: "NFT Collector",
    BRIDGE: "Cross-chain Explorer",
    IDLE: "Casual User",
  };
  
  return personas[dominant] || "Mixed Profile";
}
