import { TavilySearch } from "@langchain/tavily";
import { env } from "../../env.js";
import { runBilled } from "../../services/credits.service.js";
import type { GraphStateType } from "../state.js";

/**
 * Web search. Fetch and format only: this node never writes prose.
 *
 * The graph routes search -> chat, so the chat node writes the answer with
 * these results in its system prompt. Splitting it that way means the citation
 * style lives in one place and search stays swappable.
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

/**
 * Turn the provider payload into a numbered, citable block.
 *
 * The numbering matters: the chat prompt tells the model to cite as [1], [2],
 * and those numbers have to line up with what it was shown.
 */
function format(raw: unknown) {
  const data: TavilyShape =
    typeof raw === "string" ? JSON.parse(raw) : (raw as TavilyShape);

  const text = (data?.results ?? [])
    .map(
      (result, index) =>
        `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.content}`,
    )
    .join("\n\n");

  const images = (data?.images ?? [])
    .map((image) => (typeof image === "string" ? image : image?.url))
    .filter((url): url is string => Boolean(url));

  return { text, images };
}

export async function searchAgent(state: GraphStateType) {
  const tool = getSearchTool();

  // No API key: fall through to chat with an empty result set rather than
  // failing the request. The chat node already has wording for this case.
  if (!tool) {
    return { searchResults: "", images: [] };
  }

  return runBilled(state.userId, "search", async () => {
    state.onProgress?.("Searching the web");

    try {
      const { text, images } = format(
        await tool.invoke({ query: state.prompt }),
      );

      return { searchResults: text, images };
    } catch (error) {
      // Search being down is not the user's fault. runBilled refunds on a
      // throw, but here we want chat to still answer, so swallow and degrade.
      console.warn("[search] failed:", (error as Error).message);
      return { searchResults: "", images: [] };
    }
  });
}
