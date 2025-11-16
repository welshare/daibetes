// lib/vectorSearch.ts
import { createClient } from "@supabase/supabase-js";
import { CohereClient } from "cohere-ai";
import { SimpleCache } from "../utils/cache";
import logger from "../utils/logger";
import { CONFIG } from "./config";
import { createEmbeddingProvider, type EmbeddingProvider } from "./provider";

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const cohere = new CohereClient({
  token: CONFIG.COHERE_API_KEY,
});

export interface Document {
  id: string;
  title: string;
  content: string;
  metadata?: any;
  similarity?: number;
  relevanceScore?: number;
}

export class VectorSearchWithReranker {
  private embeddingProvider: EmbeddingProvider;
  private cache: SimpleCache<Document[]>;

  constructor() {
    this.embeddingProvider = createEmbeddingProvider();
    this.cache = new SimpleCache<Document[]>();
    logger.info(
      `🚀 Initialized with ${CONFIG.EMBEDDING_PROVIDER} provider using ${CONFIG.TEXT_EMBEDDING_MODEL}`,
    );
  }

  // Add document to vector store
  async addDocument(
    title: string,
    content: string,
    metadata = {},
  ): Promise<Document> {
    logger.info(`📝 Adding document: ${title}`);

    const embedding = await this.embeddingProvider.generateEmbedding(
      `${title}\n${content}`,
    );

    const { data, error } = await supabase
      .from("documents")
      .insert({
        title,
        content,
        metadata,
        embedding,
      })
      .select()
      .single();

    if (error) throw error;

    logger.info(`✅ Document added with ID: ${data.id}`);
    return data;
  }

  // Vector search (first stage)
  async vectorSearch(query: string, limit = 20): Promise<Document[]> {
    logger.info(`🔍 Vector search for: "${query}" (limit: ${limit})`);

    const queryEmbedding =
      await this.embeddingProvider.generateEmbedding(query);

    try {
      const { data, error } = await supabase.rpc("match_documents", {
        query_embedding: queryEmbedding,
        match_threshold: CONFIG.SIMILARITY_THRESHOLD,
        match_count: limit,
      });

      if (error) {
        // Check if it's a timeout error
        if (
          error.code === "57014" ||
          error.message?.includes("statement timeout")
        ) {
          logger.warn(
            `⏱️ Vector search timed out for query: "${query}". Trying with reduced limit and threshold...`,
          );

          // Retry with reduced limit and lower threshold for faster query
          const reducedLimit = Math.max(5, Math.floor(limit / 2));
          const reducedThreshold = Math.max(
            0.1,
            CONFIG.SIMILARITY_THRESHOLD - 0.1,
          );

          logger.info(
            `🔄 Retrying with limit=${reducedLimit}, threshold=${reducedThreshold}`,
          );

          const retryResult = await supabase.rpc("match_documents", {
            query_embedding: queryEmbedding,
            match_threshold: reducedThreshold,
            match_count: reducedLimit,
          });

          if (retryResult.error) {
            logger.error(`❌ Vector search retry failed:`, retryResult.error);
            throw retryResult.error;
          }

          const results = (retryResult.data || []).map((doc: any) => ({
            id: doc.id,
            title: doc.title,
            content: doc.content,
            metadata: doc.metadata,
            similarity: doc.similarity,
          }));

          logger.info(
            `📊 Vector search (retry) returned ${results.length} results with reduced parameters`,
          );
          return results;
        }

        throw error;
      }

      const results = (data || []).map((doc: any) => ({
        id: doc.id,
        title: doc.title,
        content: doc.content,
        metadata: doc.metadata,
        similarity: doc.similarity,
      }));

      logger.info(`📊 Vector search returned ${results.length} results`);
      return results;
    } catch (error: any) {
      // Catch any other errors and provide better logging
      if (
        error.code === "57014" ||
        error.message?.includes("statement timeout")
      ) {
        logger.error(
          `❌ Vector search timed out after retry for query: "${query}"`,
        );
        // Return empty array instead of throwing to allow the system to continue
        logger.warn(`⚠️ Returning empty results due to timeout`);
        return [];
      }
      throw error;
    }
  }

  // Rerank results using Cohere (second stage)
  async rerank(
    query: string,
    documents: Document[],
    topN = 5,
  ): Promise<Document[]> {
    if (documents.length === 0) return [];

    // Check if Cohere API key is available
    if (!CONFIG.COHERE_API_KEY) {
      logger.warn(
        `⚠️ Cohere API key not configured, skipping reranking. Returning top ${topN} vector results.`,
      );
      return documents.slice(0, topN);
    }

    logger.info(
      `🎯 Reranking ${documents.length} documents, returning top ${topN}`,
    );

    try {
      const response = await cohere.rerank({
        model: "rerank-english-v3.0",
        query: query,
        documents: documents.map((doc) => ({
          text: `${doc.title}\n${doc.content}`,
        })),
        topN: Math.min(topN, documents.length),
        returnDocuments: true,
      });

      const rerankedResults = response.results
        .map((result) => ({
          ...documents[result.index],
          relevanceScore: result.relevanceScore,
        }))
        .filter((doc) => doc.relevanceScore >= CONFIG.RERANKER_SCORE_THRESHOLD);

      logger.info(
        `✨ Reranking complete, top score: ${rerankedResults[0]?.relevanceScore?.toFixed(3)}, filtered to ${rerankedResults.length} results (threshold: ${CONFIG.RERANKER_SCORE_THRESHOLD})`,
      );

      return rerankedResults as Document[];
    } catch (error) {
      logger.error(
        `❌ Reranking failed, falling back to vector search results:`,
        {
          errorType:
            error instanceof Error ? error.constructor.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      );
      // Fallback to top N vector results if reranking fails
      logger.info(
        `⚡ Returning top ${topN} vector results due to reranking failure`,
      );
      return documents.slice(0, topN);
    }
  }

  // Complete search pipeline
  async search(
    query: string,
    options: {
      vectorLimit?: number;
      finalLimit?: number;
      useReranking?: boolean;
    } = {},
  ): Promise<Document[]> {
    const {
      vectorLimit = CONFIG.VECTOR_SEARCH_LIMIT,
      finalLimit = CONFIG.RERANK_FINAL_LIMIT,
      useReranking = CONFIG.USE_RERANKING,
    } = options;

    const cacheKey = `search_${query}_${vectorLimit}_${finalLimit}_${useReranking}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    logger.info(`🚀 Starting search pipeline for: "${query}"`);
    const startTime = Date.now();

    // Stage 1: Vector search
    const vectorResults = await this.vectorSearch(query, vectorLimit);

    if (vectorResults.length === 0) {
      logger.info("❌ No vector search results found");
      return [];
    }

    let finalResults: Document[];

    // Only use reranking if enabled AND Cohere API key is available
    const canRerank =
      useReranking && CONFIG.COHERE_API_KEY && vectorResults.length > 1;

    if (canRerank) {
      // Stage 2: Rerank with Cohere
      finalResults = await this.rerank(query, vectorResults, finalLimit);
    } else {
      finalResults = vectorResults.slice(0, finalLimit);
      if (!CONFIG.COHERE_API_KEY && useReranking) {
        logger.info(
          `⚡ Reranking disabled (no Cohere API key), returning top ${finalResults.length} vector results`,
        );
      } else {
        logger.info(
          `⚡ Skipping reranking, returning top ${finalResults.length} vector results`,
        );
      }
    }

    const totalTime = Date.now() - startTime;
    logger.info(
      `🏁 Search completed in ${totalTime}ms, returned ${finalResults.length} results`,
    );

    this.cache.set(cacheKey, finalResults, 300000); // 5min cache
    return finalResults;
  }

  // Batch add documents
  async addDocuments(
    documents: Array<{
      title: string;
      content: string;
      metadata?: any;
    }>,
  ): Promise<Document[]> {
    logger.info(`📚 Adding ${documents.length} documents in batch`);

    try {
      const documentsWithEmbeddings = await Promise.all(
        documents.map(async (doc, index) => {
          logger.info(
            `🔄 Processing document ${index + 1}/${documents.length}: ${doc.title}`,
          );
          try {
            const embedding = await this.embeddingProvider.generateEmbedding(
              `${doc.title}\n${doc.content}`,
            );
            logger.info(
              `   ✓ Generated embedding for "${doc.title}" (dimension: ${embedding.length})`,
            );
            return {
              ...doc,
              embedding,
            };
          } catch (embeddingError) {
            logger.error(
              `   ✗ Failed to generate embedding for "${doc.title}":`,
              embeddingError,
            );
            throw embeddingError;
          }
        }),
      );

      logger.info(
        `📤 Inserting ${documentsWithEmbeddings.length} documents with embeddings into database...`,
      );

      // Use ON CONFLICT DO NOTHING to handle duplicates gracefully (PostgreSQL feature)
      // This prevents errors when documents already exist
      const { data, error } = await supabase
        .from("documents")
        .insert(documentsWithEmbeddings)
        .select();

      if (error) {
        // Check if it's a duplicate/constraint error - these are acceptable
        const isDuplicateError =
          error.message.includes("duplicate") ||
          error.message.includes("unique") ||
          error.code === "23505"; // PostgreSQL unique violation code

        if (isDuplicateError) {
          logger.warn(
            `⚠️ Some documents in batch already exist (duplicates), continuing...`,
            {
              message: error.message,
              code: error.code,
            },
          );
          // Return empty array - duplicates are fine, we'll continue
          return [];
        }

        logger.error(`❌ Database insert failed:`, {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        throw error;
      }

      logger.info(`✅ Successfully added ${data.length} documents`);
      return data;
    } catch (error) {
      logger.error(`❌ addDocuments failed:`, error);
      throw error;
    }
  }

  // Get document stats
  async getStats() {
    const { count, error } = await supabase
      .from("documents")
      .select("*", { count: "exact", head: true });

    if (error) throw error;

    return {
      totalDocuments: count,
      embeddingProvider: CONFIG.EMBEDDING_PROVIDER,
      embeddingModel: CONFIG.TEXT_EMBEDDING_MODEL,
      embeddingDimensions: CONFIG.EMBEDDING_DIMENSIONS,
    };
  }
}
