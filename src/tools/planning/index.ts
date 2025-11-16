import character from "../../character";
import { LLM } from "../../llm/provider";
import { type Message, type State, type Tool } from "../../types/core";
import logger from "../../utils/logger";
import {
  composePromptFromState,
  formatConversationHistory,
  parseKeyValueXml,
  startStep,
  endStep,
} from "../../utils/state";
import { getMessagesByConversation } from "../../db/operations";
import { calculateRequestPrice } from "../../x402/pricing";

export const planningTool: Tool = {
  name: "PLANNING",
  description: "Plan the agent workflow execution",
  enabled: true,
  execute: async (input: {
    state: State;
    message: Message;
  }): Promise<{ providers: string[]; actions: string[] }> => {
    const { state, message } = input;

    startStep(state, "PLANNING");

    // Update state in DB after startStep
    if (state.id) {
      try {
        console.log('[planning] Updating state after startStep, state.id:', state.id, 'steps:', state.values.steps);
        const { updateState } = await import("../../db/operations");
        await updateState(state.id, state.values);
        console.log('[planning] State updated successfully');
      } catch (err) {
        console.error("Failed to update state in DB:", err);
      }
    } else {
      console.warn('[planning] No state.id available, skipping state update');
    }

    // TODO: idea - instead of providers/actions use a less structured approach, outline steps in 'levels'
    const prompt = composePromptFromState(
      state,
      character.templates.planningTemplate,
    );

    const PLANNING_LLM_PROVIDER = process.env.PLANNING_LLM_PROVIDER || "google";
    const planningApiKey =
      process.env[`${PLANNING_LLM_PROVIDER.toUpperCase()}_API_KEY`];

    if (!planningApiKey) {
      throw new Error(
        `${PLANNING_LLM_PROVIDER.toUpperCase()}_API_KEY is not configured.`,
      );
    }

    const planningLlmProvider = new LLM({
      // @ts-ignore
      name: PLANNING_LLM_PROVIDER,
      apiKey: planningApiKey,
    });

    const planningModel = process.env.PLANNING_LLM_MODEL || "gemini-2.5-pro";
    // planning is the most important part, so we'll make sure to try 3 times to get it right
    const MAX_RETRIES = 3;

    // Fetch conversation history (last 3 DB messages = 6 actual messages)
    let conversationHistory: any[] = [];
    try {
      conversationHistory = await getMessagesByConversation(
        message.conversation_id,
        3,
      );
      // Reverse to get chronological order (oldest first)
      conversationHistory = conversationHistory.reverse();
    } catch (err) {
      logger.warn({ err }, "failed_to_fetch_conversation_history");
    }

    // Format conversation history
    let historyText = "";
    if (conversationHistory.length > 0) {
      const formattedHistory = formatConversationHistory(conversationHistory);
      historyText = `\n\nPrevious conversation:\n${formattedHistory}\n`;
    }

    const messages = [
      {
        role: "assistant" as const,
        content: prompt,
      },
      {
        role: "user" as const,
        content: `${historyText}\n\nUser message to evaluate: ${message.question}`,
      },
    ];

    const llmRequest = {
      model: planningModel,
      messages,
      maxTokens: 1024,
    };

    logger.info(`🔵 Planning: Starting LLM request`, {
      provider: PLANNING_LLM_PROVIDER,
      model: planningModel,
      messageCount: messages.length,
      maxTokens: llmRequest.maxTokens,
      promptLength: prompt.length,
      userMessageLength: message.question?.length || 0,
    });

    for (let i = 0; i < MAX_RETRIES; i++) {
      const attemptNumber = i + 1;
      logger.info(`🔄 Planning: Attempt ${attemptNumber}/${MAX_RETRIES}`);
      
      try {
        logger.info(`📤 Planning: Sending request to ${PLANNING_LLM_PROVIDER}...`, {
          request: {
            model: llmRequest.model,
            messageCount: llmRequest.messages.length,
            maxTokens: llmRequest.maxTokens,
            firstMessagePreview: llmRequest.messages[0]?.content?.substring(0, 200) || "",
          },
        });

        const completion =
          await planningLlmProvider.createChatCompletion(llmRequest);
        
        logger.info(`📥 Planning: Received response from ${PLANNING_LLM_PROVIDER}`, {
          hasContent: !!completion.content,
          contentLength: completion.content?.length || 0,
          usage: completion.usage,
        });

        const xmlResponseText = completion.content;

        if (!xmlResponseText || xmlResponseText.trim().length === 0) {
          logger.error(`❌ Planning: Empty response received from ${PLANNING_LLM_PROVIDER}`, {
            attempt: attemptNumber,
            completion: JSON.stringify(completion, null, 2),
          });
          throw new Error(`Empty response from ${PLANNING_LLM_PROVIDER}`);
        }

        logger.info(`📄 Planning: LLM response content (${xmlResponseText.length} chars):`, {
          preview: xmlResponseText.substring(0, 500),
          fullContent: xmlResponseText,
        });

        logger.info(`🔍 Planning: Attempting to parse XML response...`);
        const parsedXmlResponse = parseKeyValueXml(xmlResponseText);
        
        if (!parsedXmlResponse) {
          logger.error(`❌ Planning: Failed to parse XML response`, {
            attempt: attemptNumber,
            rawResponse: xmlResponseText,
            responseLength: xmlResponseText.length,
          });
          throw new Error("Failed to parse XML response");
        }

        logger.info(`✅ Planning: Successfully parsed XML response`, {
          attempt: attemptNumber,
          parsedKeys: Object.keys(parsedXmlResponse),
        });

        const providersRaw = parsedXmlResponse.providers;
        const providerList = Array.isArray(providersRaw)
          ? providersRaw
          : typeof providersRaw === "string"
          ? providersRaw
              .split(",")
              .map((p: string) => p.trim())
              .filter(Boolean)
          : [];

        const actionsRaw = parsedXmlResponse.actions;
        const actionList = Array.isArray(actionsRaw)
          ? actionsRaw
          : typeof actionsRaw === "string"
          ? actionsRaw
              .split(",")
              .map((a: string) => a.trim())
              .filter(Boolean)
          : [];

        // Initialize estimatedCostsUSD object if it doesn't exist
        if (!state.values.estimatedCostsUSD) {
          state.values.estimatedCostsUSD = {};
        }

        // Store estimated cost for PLANNING tool specifically
        const planningCost = calculateRequestPrice(["PLANNING"]);
        state.values.estimatedCostsUSD["PLANNING"] = parseFloat(planningCost);

        logger.info(`✅ Planning: Successfully completed on attempt ${attemptNumber}`, {
          providers: providerList,
          actions: actionList,
          estimatedCost: planningCost,
        });

        endStep(state, "PLANNING");

        // Update state in DB after endStep
        if (state.id) {
          try {
            const { updateState } = await import("../../db/operations");
            await updateState(state.id, state.values);
          } catch (err) {
            console.error("Failed to update state in DB:", err);
          }
        }

        return {
          providers: providerList,
          actions: actionList,
        };
      } catch (error) {
        const errorDetails = {
          attempt: attemptNumber,
          provider: PLANNING_LLM_PROVIDER,
          model: planningModel,
          errorType: error instanceof Error ? error.constructor.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
          fullError: error,
        };

        logger.error(`❌ Planning: Failed on attempt ${attemptNumber}/${MAX_RETRIES}`, errorDetails);

        if (attemptNumber < MAX_RETRIES) {
          logger.info(`⏳ Planning: Retrying in next attempt...`);
        } else {
          logger.error(`💥 Planning: All ${MAX_RETRIES} attempts failed. Giving up.`);
        }
      }
    }

    // planning LLM failed, return empty arrays
    logger.error(`🚫 Planning: All retries exhausted. Returning empty providers and actions.`);
    endStep(state, "PLANNING");

    // Update state in DB after endStep
    if (state.id) {
      try {
        const { updateState } = await import("../../db/operations");
        await updateState(state.id, state.values);
      } catch (err) {
        console.error("Failed to update state in DB:", err);
      }
    }

    return {
      providers: [],
      actions: [],
    };
  },
};
