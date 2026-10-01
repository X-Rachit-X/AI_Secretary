/**
 * Token prices, so a run can be costed.
 *
 * USD per 1 million tokens. These move; treat the numbers as a budgeting
 * estimate, not an invoice. What matters architecturally is that cost is
 * computed in ONE place from token counts the provider reports, rather than
 * guessed at per call site.
 *
 * A model that is not listed costs 0, which shows up as a suspiciously free
 * agent on the Insights page — that is the intended signal to add it here.
 */

export type Price = { inputPerMillion: number; outputPerMillion: number };

const PRICES: Record<string, Price> = {
  // Google
  "gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  "gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gemini-2.0-flash": { inputPerMillion: 0.1, outputPerMillion: 0.4 },

  // OpenAI
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },

  // Anthropic
  "claude-sonnet-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },

  // Groq
  "llama-3.3-70b-versatile": { inputPerMillion: 0.59, outputPerMillion: 0.79 },
};

export function priceFor(model: string): Price {
  // Providers suffix model ids ("gemini-2.5-flash-002", "models/gemini-..."),
  // so match on the longest listed id the string contains.
  const match = Object.keys(PRICES)
    .filter((key) => model.includes(key))
    .sort((a, b) => b.length - a.length)[0];

  return match ? PRICES[match] : { inputPerMillion: 0, outputPerMillion: 0 };
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = priceFor(model);

  return (
    (inputTokens / 1_000_000) * price.inputPerMillion +
    (outputTokens / 1_000_000) * price.outputPerMillion
  );
}
