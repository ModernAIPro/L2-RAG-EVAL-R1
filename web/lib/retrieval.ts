import { readFileSync } from "node:fs";
import path from "node:path";
import type OpenAI from "openai";

/**
 * Retrieval against the flat index written by rag/export_web.py.
 *
 * The Python side stores vectors in Chroma; here we brute-force 1173 dot
 * products, which is faster than any index would be at this size and exact
 * besides. Regenerate both files together after re-ingesting.
 */

export type Chunk = {
  id: string;
  source: string;
  page: number;
  form: string;
  year: string;
  text: string;
};

export type Hit = Chunk & { distance: number };

export const TOP_K = 5;
// Matches rag/ask.py. In-corpus questions land near 0.6-0.8, unrelated ones near
// 1.7, so this rejects nonsense before it can reach the model.
export const MAX_DISTANCE = 1.2;

const EMBED_MODEL = process.env.EMBED_MODEL ?? "text-embedding-3-small";

type Index = { chunks: Chunk[]; vectors: Float32Array; dim: number };

// Module scope, so a warm serverless invocation reuses the parsed index rather
// than re-reading 8.6 MB per request.
let cached: Index | null = null;

function load(): Index {
  if (cached) return cached;

  const dir = path.join(process.cwd(), "data");
  const meta = JSON.parse(readFileSync(path.join(dir, "chunks.json"), "utf-8"));
  const raw = readFileSync(path.join(dir, "vectors.bin"));

  // Node may hand back a Buffer whose byteOffset is non-zero, so slice the exact
  // window rather than assuming the underlying ArrayBuffer starts at the data.
  const vectors = new Float32Array(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
  );

  const expected = meta.count * meta.dim;
  if (vectors.length !== expected) {
    throw new Error(
      `vectors.bin has ${vectors.length} floats, chunks.json implies ${expected}. ` +
        "Re-run python rag/export_web.py to regenerate the pair.",
    );
  }

  cached = { chunks: meta.chunks, vectors, dim: meta.dim };
  return cached;
}

/**
 * Chroma's default space is squared L2, and the embeddings are unit length, so
 * `2 - 2*dot` reproduces its distances exactly — which is what lets MAX_DISTANCE
 * carry the same meaning here as it does in the Python scripts.
 */
export type Retrieved = {
  hits: Hit[];
  /** The embedding call's own token usage, so the caller can price the turn. */
  usage: { model: string; prompt: number; completion: number };
};

export async function retrieve(client: OpenAI, query: string): Promise<Retrieved> {
  const { chunks, vectors, dim } = load();

  const response = await client.embeddings.create({
    model: EMBED_MODEL,
    input: [query],
    // Not the SDK default, which is base64. Decoded against the class proxy that
    // yields 384 zeros instead of 1536 floats, so every distance comes out NaN.
    // Asking for floats outright avoids depending on how the proxy encodes.
    encoding_format: "float",
  });
  const q = response.data[0].embedding;

  if (q.length !== dim) {
    throw new Error(
      `Query embedding is ${q.length} dims, index is ${dim}. ` +
        `Is EMBED_MODEL (${EMBED_MODEL}) the model rag/ingest.py used?`,
    );
  }

  const scored: Hit[] = chunks.map((chunk, i) => {
    let dot = 0;
    const start = i * dim;
    for (let j = 0; j < dim; j++) dot += q[j] * vectors[start + j];
    return { ...chunk, distance: 2 - 2 * dot };
  });

  scored.sort((a, b) => a.distance - b.distance);
  return {
    hits: scored.slice(0, TOP_K),
    usage: {
      model: response.model ?? EMBED_MODEL,
      prompt: response.usage?.prompt_tokens ?? 0,
      completion: 0,
    },
  };
}

/** The numbered blocks the model sees. Index i here is citation [i+1]. */
export function excerpts(hits: Hit[]): string {
  return hits
    .map((h, i) => `[${i + 1}] ${h.form} ${h.year}, page ${h.page}\n${h.text}`)
    .join("\n\n");
}
