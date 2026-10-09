import { TavilySearch } from "@langchain/tavily";
import { env } from "../../env.js";

/**
 * Web search, as a plain function.
 *
 * Fetch and format only — it never writes prose. The caller (a ReAct loop)
 * decides what to do with the results, which is the whole reason this is a
 * tool rather than an agent: it has no judgement to exercise.
 */

let searchTool: TavilySearch | null = null;

function getSearchTool() {
  if (!env.tavilyApiKey) return null;

  if (!searchTool) {
    searchTool = new TavilySearch({
      tavilyApiKey: env.tavilyApiKey,
      maxResults: 5,
      topic: "general",
      includeImages: true,
    });
  }

  return searchTool;
}

type TavilyShape = {
  results?: Array<{ title?: string; url?: string; content?: string }>;
  images?: Array<string | { url?: string }>;
};

export type SearchResult = {
  /** Numbered, citable text block. Empty when search is unavailable. */
  text: string;
  images: string[];
  resultCount: number;
};

/**
 * Turn the provider payload into a numbered, citable block.
 *
 * The numbering matters: callers tell the model to cite as [1], [2], and those
 * numbers have to line up with what it was shown.
 */
function format(raw: unknown): SearchResult {
  const data: TavilyShape =
    typeof raw === "string" ? JSON.parse(raw) : (raw as TavilyShape);

  const results = data?.results ?? [];

  const text = results
    .map(
      (result, index) =>
        `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.content}`,
    )
    .join("\n\n");

  const images = (data?.images ?? [])
    .map((image) => (typeof image === "string" ? image : image?.url))
    .filter((url): url is string => Boolean(url));

  return { text, images, resultCount: results.length };
}

export async function searchWeb(query: string): Promise<SearchResult> {
  const tool = getSearchTool();

  // No API key: return an empty result rather than throwing, so the caller can
  // say "I could not search" and still answer from what it knows.
  if (!tool) return { text: "", images: [], resultCount: 0 };

  try {
    return format(await tool.invoke({ query }));
  } catch (error) {
    console.warn("[search] failed:", (error as Error).message);
    return { text: "", images: [], resultCount: 0 };
  }
}

export const searchConfigured = () => Boolean(env.tavilyApiKey);
