import { readFile } from "node:fs/promises";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { MemoryVectorStore } from "../vector-store.js";
import { PDFParse } from "pdf-parse";
import { getEmbeddings } from "../models.js";
import { invokeModel } from "../gateway.js";
import { runBilled } from "../../services/credits.service.js";
import { AppError } from "../../lib/errors.js";
import type { GraphStateType } from "../state.js";

/**
 * Chat with an uploaded PDF. A complete RAG pipeline in one file:
 *
 *   extract text -> split into chunks -> embed -> similarity search -> answer
 *
 * The vector store is in-memory (see ai/vector-store.ts) and lives only for
 * this one request. The original project ran a Qdrant container and deleted
 * the collection in a `finally` block; for a single document answering a
 * single question, the embeddings are the cost and the database adds nothing
 * but operations work.
 *
 * Trade-off worth knowing: a follow-up question re-embeds the document. If you
 * want to avoid that, persist the store keyed by file hash.
 */

const TOP_K = 5;
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

const SYSTEM = `You are AI Secretary Document Assistant.

Rules:
- Answer ONLY from the provided document context.
- Never use outside knowledge and never fill a gap with a plausible guess.
- If the answer is not in the context, say exactly:
  "I could not find this in the uploaded document."
- Quote short phrases from the document when they support your answer.
- Use Markdown formatting.`;

async function extractText(filePath: string): Promise<string> {
  const parser = new PDFParse({ data: await readFile(filePath) });

  try {
    const { text } = await parser.getText();
    return text?.trim() ?? "";
  } finally {
    await parser.destroy?.();
  }
}

export async function docqaAgent(state: GraphStateType) {
  if (!state.file) {
    throw AppError.badRequest("No PDF was attached.");
  }

  state.onProgress?.("Reading the document");

  // Extraction is local and free, so it happens BEFORE billing. A scanned PDF
  // with no text layer should cost the user nothing.
  const text = await extractText(state.file.path);

  if (!text) {
    return {
      response: [
        "I could not extract any text from that PDF.",
        "",
        "It is most likely a scan, so the pages are images with no text layer.",
        "Upload a text-based PDF, or upload the pages as images and I will read",
        "them with the vision agent instead.",
      ].join("\n"),
    };
  }

  return runBilled(state.userId, "docqa", async () => {
    state.onProgress?.("Indexing the document");

    const documents = await new RecursiveCharacterTextSplitter({
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
    }).createDocuments([text]);

    const store = await MemoryVectorStore.fromDocuments(
      documents,
      getEmbeddings(),
    );

    state.onProgress?.("Finding the relevant passages");

    const question =
      state.prompt?.trim() || "Summarise this document in clear bullet points.";

    const matches = await store.similaritySearch(question, TOP_K);

    const context = matches
      .map((match, index) => `[Chunk ${index + 1}]\n${match.pageContent}`)
      .join("\n\n");

    const result = await invokeModel(
      [
        new SystemMessage(SYSTEM),
        new HumanMessage(
          `Document context:\n\n${context}\n\nQuestion:\n${question}`,
        ),
      ],
      { role: "docqa", meter: state.meter },
    );

    return {
      response: `${String(result.content)}\n\n---\n*Answered from ${documents.length} chunks of ${state.file!.originalname}.*`,
    };
  });
}
