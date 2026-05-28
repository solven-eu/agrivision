// AgriVision RE — Anthropic token accounting + cost estimation.
//
// Every /v1/messages response carries a `usage` block:
//   { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
// We parse it on every turn, accumulate per-conversation totals, and (optionally) enforce
// a client-side soft cap. Hard enforcement is a server-side concern — see ROADMAP.

// USD per million tokens. Update when Anthropic changes pricing.
// Cache write = +25% of input. Cache read = 10% of input (90% discount).
const PRICING = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-opus-4-1": { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 },
};

/** Return USD cost for one Anthropic `usage` block, given the model name. */
export function costOfUsage(usage, model) {
  if (!usage) return 0;
  const p = PRICING[model] || PRICING["claude-haiku-4-5"];
  const inp = ((usage.input_tokens || 0) * p.input) / 1e6;
  const cw = ((usage.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6;
  const cr = ((usage.cache_read_input_tokens || 0) * p.cacheRead) / 1e6;
  const out = ((usage.output_tokens || 0) * p.output) / 1e6;
  return inp + cw + cr + out;
}

/** Sum the input-equivalent tokens (counts cached separately for display). */
export function totalInputTokens(usage) {
  return (
    (usage?.input_tokens || 0) +
    (usage?.cache_creation_input_tokens || 0) +
    (usage?.cache_read_input_tokens || 0)
  );
}

export function fmtTokens(n) {
  if (n == null || isNaN(n)) return "—";
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(1) + "k";
  return (n / 1e6).toFixed(2) + "M";
}

export function fmtCost(usd) {
  if (usd == null || isNaN(usd)) return "—";
  if (usd < 0.01) return "$" + usd.toFixed(4);
  if (usd < 1) return "$" + usd.toFixed(3);
  return "$" + usd.toFixed(2);
}

/**
 * @returns {{ accumulate, reset, snapshot, atSoftLimit, atHardLimit, restore }}
 */
export function createTokenTracker({ softLimit = 200_000, hardLimit = 500_000 } = {}) {
  let totals = {
    input: 0,
    output: 0,
    cache_creation: 0,
    cache_read: 0,
    cost_usd: 0,
    turns: 0,
  };

  function accumulate(usage, model) {
    if (!usage) return;
    totals.input += usage.input_tokens || 0;
    totals.output += usage.output_tokens || 0;
    totals.cache_creation += usage.cache_creation_input_tokens || 0;
    totals.cache_read += usage.cache_read_input_tokens || 0;
    totals.cost_usd += costOfUsage(usage, model);
    totals.turns += 1;
  }

  function reset() {
    totals = { input: 0, output: 0, cache_creation: 0, cache_read: 0, cost_usd: 0, turns: 0 };
  }

  function restore(saved) {
    if (saved && typeof saved === "object") totals = { ...totals, ...saved };
  }

  function snapshot() {
    return { ...totals };
  }

  function totalIn() {
    return totals.input + totals.cache_creation + totals.cache_read;
  }

  function atSoftLimit() {
    return totalIn() + totals.output >= softLimit;
  }

  function atHardLimit() {
    return totalIn() + totals.output >= hardLimit;
  }

  return { accumulate, reset, snapshot, restore, atSoftLimit, atHardLimit };
}
