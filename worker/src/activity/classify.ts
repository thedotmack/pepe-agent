/**
 * Placeholder market classifier.
 *
 * Looks at the signal mix across the snapshot and emits a coarse label.
 * The real strategy lives in the agent + claude-mem observations; this
 * heuristic only exists so the snapshot we record carries a baseline
 * "what did the market look like" hint.
 */
import type { ActivityToken } from "./subscriber.ts";

export type MarketCondition =
  | "STRONG_BULL"
  | "BULLISH"
  | "NEUTRAL"
  | "BEARISH"
  | "STRONG_BEAR";

export interface SignalCounts {
  strongCount: number;
  risingCount: number;
  watchCount: number;
  flatCount: number;
}

export function countSignals(snapshot: ActivityToken[]): SignalCounts {
  let strongCount = 0;
  let risingCount = 0;
  let watchCount = 0;
  let flatCount = 0;
  for (const t of snapshot) {
    switch (t.signal) {
      case "STRONG":
        strongCount += 1;
        break;
      case "RISING":
        risingCount += 1;
        break;
      case "WATCH":
        watchCount += 1;
        break;
      case "FLAT":
        flatCount += 1;
        break;
      default:
        flatCount += 1;
    }
  }
  return { strongCount, risingCount, watchCount, flatCount };
}

export function classifyMarket(snapshot: ActivityToken[]): MarketCondition {
  const total = snapshot.length || 1;
  const { strongCount, risingCount, flatCount } = countSignals(snapshot);

  const strongRatio = strongCount / total;
  const risingRatio = risingCount / total;
  const flatRatio = flatCount / total;
  const upRatio = strongRatio + risingRatio;

  if (strongRatio >= 0.3) return "STRONG_BULL";
  if (upRatio >= 0.4) return "BULLISH";
  if (flatRatio >= 0.85) return "STRONG_BEAR";
  if (flatRatio >= 0.65) return "BEARISH";
  return "NEUTRAL";
}
