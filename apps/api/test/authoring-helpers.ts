// Sources and authoring against everything real but the model: Postgres + pgvector, pg-boss workers, the verify
// parent and the LLM runtime, with the mock server answering chat and embeddings.
import { EMBEDDING_DIMENSIONS } from "@gem/db";
import type { Capabilities, EmbeddingConfig } from "@gem/shared";
import { assign } from "../../../packages/llm/test/helpers.ts";
import { Queue } from "../src/queue.ts";
import { startSourceWorker } from "../src/sources.ts";
import { API, type Client, registerUser, signIn } from "./helpers.ts";
import { createL7Env, type L7Env } from "./l7-helpers.ts";

export const EMBEDDING: EmbeddingConfig = {
  dimensions: EMBEDDING_DIMENSIONS,
  queryPrefix: "query-prefix: ",
  documentPrefix: "document-prefix: ",
};

export const EMBED_CAPABILITIES: Partial<Capabilities> = { maxInputTokens: 2048 };

export interface SourceEnv extends L7Env {
  queue: Queue;
  admin: Client;
  proctor: Client;
  proctorId: string;
  other: Client;
  student: Client;
  /** Assigns `embeddings` on the mock, optionally with another model or dimensions. */
  assignEmbeddings(o?: { model?: string; dimensions?: number; maxInputTokens?: number }): Promise<void>;
  /** Waits for a source's latest revision to leave the queue. */
  settled(client: Client, id: string): Promise<SourceBody>;
}

export interface SourceBody {
  id: string;
  title: string;
  usable: boolean;
  latest: {
    id: string;
    number: number;
    embedStatus: string;
    embedError: { code: string; params: Record<string, unknown> } | null;
    chunks: number;
    embedded: number;
  };
}

export async function createSourceEnv(env: Record<string, string> = {}): Promise<SourceEnv> {
  const l7 = await createL7Env({}, env, { dimensions: EMBEDDING_DIMENSIONS, embedCap: 4096 });
  const queue = await Queue.start(l7.t.database.appUrl, () => {});
  l7.t.ctx.queue = queue;
  await startSourceWorker(l7.t.ctx);
  const assignEmbeddings: SourceEnv["assignEmbeddings"] = async (o = {}) => {
    await assign(l7.t.db, "embeddings", {
      url: l7.mock.url,
      timeoutMs: 20_000,
      ...(o.model ? { model: o.model } : {}),
      capabilities: { ...EMBED_CAPABILITIES, ...(o.maxInputTokens ? { maxInputTokens: o.maxInputTokens } : {}) },
      embedding: { ...EMBEDDING, dimensions: o.dimensions ?? EMBEDDING_DIMENSIONS },
    });
  };
  await assignEmbeddings();
  const admin = (await registerUser(l7.t.app, "admin@example.com")).client;
  const p = await registerUser(l7.t.app, "proctor@example.com");
  const o = await registerUser(l7.t.app, "other@example.com");
  const student = (await registerUser(l7.t.app, "student@example.com")).client;
  for (const u of [p, o]) await admin.put(`${API}/admin/users/${u.user.id}/roles`, { role: "proctor" });
  const proctor = (await signIn(l7.t.app, "proctor@example.com")).client;
  const other = (await signIn(l7.t.app, "other@example.com")).client;
  return {
    ...l7,
    queue,
    admin,
    proctor,
    proctorId: p.user.id,
    other,
    student,
    assignEmbeddings,
    async settled(client, id) {
      for (let i = 0; i < 300; i++) {
        const body = (await client.get(`${API}/sources/${id}`)).json();
        const status = body.source?.latest?.embedStatus;
        if (status === "ready" || status === "failed") return body.source as SourceBody;
        await Bun.sleep(50);
      }
      throw new Error("the embedding job never finished");
    },
    async close() {
      await queue.stop();
      await l7.close();
    },
  };
}

/** A small book: two chapters, a code block, a table, display math. */
export const BOOK = `# Chapter 1: Vectors

A vector is an ordered list of numbers. We write $x = (x_1, \\ldots, x_n)$ for a vector of length $n$.

## Inner product

The inner product of two vectors is $x^T y = x_1 y_1 + \\cdots + x_n y_n$. Two vectors are orthogonal when it is zero.

$$
\\|x\\| = \\sqrt{x^T x}
$$

## Norms

The norm measures length, and it is never negative.

| Vector | Norm |
|---|---|
| (3, 4) | 5 |

\`\`\`python
print("code stays whole")
\`\`\`

# Chapter 2: Matrices

A matrix is a rectangular array of numbers. Matrix multiplication isn't commutative.
`;
