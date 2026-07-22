# Chart Architecture

## Overview

The chart system consists of multiple layers optimized for high-frequency trading data from Pump.fun.

## Components

### Main Chart Components

| Component | Purpose | Size |
|-----------|---------|------|
| `PumpFunChart.tsx` | Main chart with live stream, markers, full feature set | ~730 lines |
| `TokenPriceChart.tsx` | Simplified chart (legacy, consider unifying) | ~265 lines |

### Chart Sub-components

| Component | Purpose |
|-----------|---------|
| `ChartHeader.tsx` | Token info, metrics, social links |
| `ChartToolbar.tsx` | Timeframe selector, zoom controls |
| `CandleTitleBar.tsx` | OHLC display on hover |
| `ActivityPanel.tsx` | Live trades list (with virtualization) |
| `BottomTabs.tsx` | Additional token info tabs |
| `ChartErrorBoundary.tsx` | Error isolation |

## Data Flow

```
Pump.fun API → token-history/route.ts → useOHLCV.ts → PumpFunChart.tsx
                                    ↓
PumpPortal WS → useTradeStream.ts → direct chart update (bypassing React state)
```

## Key Optimizations

### 1. Direct Chart Updates (Zero React Overhead)
Live trades update the chart directly via `candleRef.current.update()` without triggering React re-renders.

### 2. Virtualization
`ActivityPanel` uses window virtualization - only visible trades are rendered (~10 of 100).

### 3. Memoization
- `mergedMarkers` - recalculated only when markers/counts change
- `metrics` in ChartHeader - formatted values cached
- `normalizedCandles` - computed once per data change

### 4. RAF Throttling
`useOHLCV` batches updates via `requestAnimationFrame` to prevent render flooding.

## Configuration

Unified config in `lib/chart/config.ts`:

```typescript
import { CHART_COLORS, formatMcap, formatUsd } from "@/lib/chart/config";

// Colors
CHART_COLORS.up    // #26a69a (green)
CHART_COLORS.down  // #ef5350 (red)
CHART_COLORS.grid  // #1f1f2e
```

## Hooks

| Hook | Purpose |
|------|---------|
| `useOHLCV.ts` | Main data fetching (454 lines, complex) |
| `useTradeStream.ts` | Live trade polling (shared singleton) |
| `useChartData.ts` | New optimized data management |
| `useChartMarkers.ts` | Marker state management |

## API Routes

| Route | Purpose |
|-------|---------|
| `token-history/route.ts` | Historical candles (704 lines, multi-source) |
| `token-ohlcv/route.ts` | Token metadata + fees calculation |
| `token-trades/route.ts` | Live trades feed |

## Performance Checklist

- [ ] Chart updates skip React render cycle
- [ ] Virtualization for lists >20 items
- [ ] Memoization for expensive computations
- [ ] Error boundaries isolate crashes
- [ ] Unified config prevents color drift

## Future Improvements

1. **Unify charts**: Merge PumpFunChart and TokenPriceChart
2. **WebWorker**: Move aggregation off main thread
3. **Streaming**: True WebSocket instead of polling
4. **SWR**: Replace custom cache with SWR/React Query
