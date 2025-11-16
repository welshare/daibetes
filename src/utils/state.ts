import type { WebSearchResult } from "../llm/types";
import type { Paper, State } from "../types/core";
import logger from "./logger";
import character from "../character";
import { LLM } from "../llm/provider";

// TODO: make state a separate table rather than a column in the messages table

export function addVariablesToState(
  state: State,
  variables: Record<string, any>,
) {
  state.values = {
    ...state.values,
    ...variables,
  };
}

export function startStep(state: State, stepName: string) {
  if (!state.values.steps) {
    state.values.steps = {};
  }
  state.values.steps[stepName] = {
    start: Date.now(),
  };
}

export function endStep(state: State, stepName: string) {
  if (!state.values.steps) {
    state.values.steps = {};
  }
  if (!state.values.steps[stepName]) {
    state.values.steps[stepName] = {};
  }
  state.values.steps[stepName].end = Date.now();
}

export function composePromptFromState(state: State, prompt: string): string {
  // for each key in state.values, replace the {{key}} with the value of the key
  for (const key in state.values) {
    prompt = prompt.replace(`{{${key}}}`, state.values[key]);
  }
  return prompt;
}

export function getUniquePapers(state: State): Paper[] {
  // Merge papers from KG, OpenScholar, and Semantic Scholar without duplicates
  const kgPapers = state.values.kgPapers || [];

  // Transform OpenScholar raw data to include chunk text as abstract
  const openScholarPapers = (state.values.openScholarRaw || []).map(
    (paper: any) => ({
      doi: paper.doi,
      title: paper.title,
      abstract: paper.chunkText, // Use chunk text as abstract
    }),
  );

  // Semantic Scholar papers already in correct format
  const semanticScholarPapers = state.values.semanticScholarPapers || [];

  const allPapers = [...kgPapers, ...openScholarPapers, ...semanticScholarPapers];
  // Deduplicate by DOI (keep first occurrence)
  const seenDois = new Set<string>();
  const uniquePapers = allPapers.filter((paper) => {
    const doi = paper.doi;
    if (!doi || seenDois.has(doi)) return false;
    seenDois.add(doi);
    return true;
  });

  return uniquePapers;
}

export function cleanWebSearchResults(
  webSearchResults: WebSearchResult[],
): WebSearchResult[] {
  return webSearchResults.map((result) => {
    let cleanedTitle = result.title;

    // Check if title looks like a URL
    if (
      cleanedTitle.startsWith("http://") ||
      cleanedTitle.startsWith("https://") ||
      cleanedTitle.startsWith("www.")
    ) {
      try {
        // Parse the URL to extract just the domain
        const urlToParse = cleanedTitle.startsWith("www.")
          ? `https://${cleanedTitle}`
          : cleanedTitle;
        const parsedUrl = new URL(urlToParse);
        cleanedTitle = parsedUrl.hostname.replace(/^www\./, "www.");

        // Ensure it starts with www.
        if (!cleanedTitle.startsWith("www.")) {
          cleanedTitle = "www." + cleanedTitle;
        }
      } catch {
        // If parsing fails, keep the original title
      }
    }

    return {
      ...result,
      title: cleanedTitle,
    };
  });
}

/**
 * Format conversation history from DB messages
 * Each DB message contains both user question and assistant response
 * @param messages - Array of messages from the database
 * @returns Formatted conversation history string
 */
export function formatConversationHistory(messages: any[]): string {
  if (!messages || messages.length === 0) {
    return "";
  }

  return messages
    .flatMap((msg) => {
      const formattedMessages = [];
      if (msg.question) {
        formattedMessages.push(`User: ${msg.question}`);
      }
      if (msg.content) {
        formattedMessages.push(`Assistant: ${msg.content}`);
      }
      return formattedMessages;
    })
    .join("\n");
}

/**
 * Generate a standalone message from conversation thread
 * If thread has only 1 message, returns the message as-is
 * Otherwise, uses LLM to create a standalone question from conversation context
 * @param thread - Array of messages from the database
 * @param latestMessage - The latest user message
 * @returns Standalone message string
 */
export async function getStandaloneMessage(
  thread: any[],
  latestMessage: string,
): Promise<string> {
  logger.info(`🔵 getStandaloneMessage: Starting`, {
    threadLength: thread.length,
    latestMessageLength: latestMessage.length,
    latestMessagePreview: latestMessage.substring(0, 100),
  });

  // If thread is empty or only has 1 message, return the message as-is
  if (thread.length <= 1) {
    logger.info(`🔵 getStandaloneMessage: Thread too short, returning original message`);
    return latestMessage;
  }

  // Format conversation history (exclude the last message as it's passed separately)
  const conversationHistory = formatConversationHistory(thread.slice(0, -1));

  logger.info(`🔵 getStandaloneMessage: Formatted conversation history`, {
    historyLength: conversationHistory.length,
    historyPreview: conversationHistory.substring(0, 200),
  });

  const prompt = character.templates.standaloneMessageTemplate
    .replace("{conversationHistory}", conversationHistory)
    .replace("{latestMessage}", latestMessage);

  logger.info(`🔵 getStandaloneMessage: Created prompt`, {
    promptLength: prompt.length,
    promptPreview: prompt.substring(0, 300),
  });

  const llmProviderName = (process.env.STRUCTURED_LLM_PROVIDER as any) || "openai";
  const llmApiKey = process.env[`${llmProviderName.toUpperCase()}_API_KEY`];
  
  if (!llmApiKey) {
    logger.error(`❌ getStandaloneMessage: API key missing`, {
      provider: llmProviderName,
      envVar: `${llmProviderName.toUpperCase()}_API_KEY`,
    });
    throw new Error(`${llmProviderName.toUpperCase()}_API_KEY is not configured.`);
  }

  const llmProvider = new LLM({
    name: llmProviderName,
    apiKey: llmApiKey,
  });

  const llmRequest = {
    model: process.env.STRUCTURED_LLM_MODEL || "gpt-4o-mini",
    messages: [
      {
        role: "user" as const,
        content: prompt,
      },
    ],
    maxTokens: 150,
  };

  logger.info(`🔵 getStandaloneMessage: Sending LLM request`, {
    provider: llmProviderName,
    model: llmRequest.model,
    maxTokens: llmRequest.maxTokens,
  });

  try {
    const llmResponse = await llmProvider.createChatCompletion(llmRequest);

    logger.info(`🔵 getStandaloneMessage: Received LLM response`, {
      hasContent: !!llmResponse.content,
      contentLength: llmResponse.content?.length || 0,
      contentPreview: llmResponse.content?.substring(0, 200) || "",
      usage: llmResponse.usage,
    });

    if (!llmResponse.content || llmResponse.content.trim().length === 0) {
      logger.error(`❌ getStandaloneMessage: Empty response received`, {
        fullResponse: JSON.stringify(llmResponse, null, 2),
      });
      // Fallback to original message if LLM returns empty
      logger.warn(`⚠️ getStandaloneMessage: Falling back to original message`);
      return latestMessage;
    }

    const trimmedContent = llmResponse.content.trim();
    logger.info(`✅ getStandaloneMessage: Returning standalone message`, {
      resultLength: trimmedContent.length,
      result: trimmedContent,
    });

    return trimmedContent;
  } catch (error) {
    logger.error(`❌ getStandaloneMessage: LLM request failed`, {
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    });
    // Fallback to original message on error
    logger.warn(`⚠️ getStandaloneMessage: Falling back to original message due to error`);
    return latestMessage;
  }
}

export function parseKeyValueXml(text: string): Record<string, any> | null {
  if (!text) return null;

  // First, try to find a specific <response> block (the one we actually want)
  // Use a more permissive regex to handle cases where there might be multiple XML blocks
  let xmlBlockMatch = text.match(/<response>([\s\S]*?)<\/response>/);
  let xmlContent: string;

  if (xmlBlockMatch) {
    xmlContent = xmlBlockMatch[1]!;
    logger.debug("Found response XML block");
  } else {
    // Fall back to finding any XML block (e.g., <response>...</response>)
    const fallbackMatch = text.match(/<(\w+)>([\s\S]*?)<\/\1>/);
    if (!fallbackMatch) {
      logger.warn("Could not find XML block in text");
      logger.debug(`Text content: ${text.substring(0, 200)}...`);
      return null;
    }
    xmlContent = fallbackMatch[2]!;
    logger.debug(`Found XML block with tag: ${fallbackMatch[1]}`);
  }

  const result: Record<string, any> = {};

  // Regex to find <key>value</key> patterns
  const tagPattern = /<([\w-]+)>([\s\S]*?)<\/([\w-]+)>/g;
  let match;

  while ((match = tagPattern.exec(xmlContent)) !== null) {
    // Ensure opening and closing tags match
    if (match[1] === match[3]) {
      const key = match[1]!;
      // Basic unescaping for common XML entities (add more as needed)
      const value = match[2]!
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .trim();

      // Handle potential comma-separated lists for specific keys
      if (key === "actions" || key === "providers" || key === "evaluators") {
        result[key] = value ? value.split(",").map((s) => s.trim()) : [];
      } else if (key === "simple") {
        result[key] = value.toLowerCase() === "true";
      } else {
        result[key] = value;
      }
    } else {
      logger.warn(
        `Mismatched XML tags found: <${match[1]}> and </${match[3]}>`,
      );
      // Potentially skip this mismatched pair or return null depending on strictness needed
    }
  }

  // Return null if no key-value pairs were found
  if (Object.keys(result).length === 0) {
    logger.warn("No key-value pairs extracted from XML content");
    logger.debug(`XML content was: ${xmlContent.substring(0, 200)}...`);
    return null;
  }

  return result;
}
