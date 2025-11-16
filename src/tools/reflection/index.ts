import { updateConversationState, updateState } from "../../db/operations";
import { LLM } from "../../llm/provider";
import {
  type ConversationState,
  type Message,
  type State,
} from "../../types/core";
import logger from "../../utils/logger";
import { endStep, startStep } from "../../utils/state";
import { getReflectionPrompt } from "./prompts";

export const reflectionTool = {
  name: "REFLECTION",
  description:
    "Reflect on the agent's conversation and adapts the conversation state based on the conversation",
  enabled: true,
  execute: async (input: {
    state: State;
    conversationState: ConversationState;
    message: Message;
  }) => {
    const { state, conversationState, message } = input;

    // start step for reflection
    startStep(state, "REFLECTION");

    if (state.id) {
      try {
        await updateState(state.id, state.values);
      } catch (err) {
        console.error("Failed to update state in DB:", err);
      }
    }

    const allPapersFromState = [
      ...(state.values.openScholarPapers || []),
      ...(state.values.semanticScholarPapers || []),
      ...(state.values.kgPapers || []),
    ];

    const hypothesis = state.values.hypothesis;

    // if conversation state is empty, then we will take everything related to the message state
    if (
      !conversationState ||
      !conversationState.values ||
      Object.keys(conversationState.values).length === 0
    ) {
      logger.info(
        "Conversation state is empty, taking everything related to the message state",
      );

      // we will take everything related to the message state
      conversationState.values = {
        ...conversationState.values,
        hypothesis,
        papers: allPapersFromState,
      };
    } else {
      // we need a prompt to reflect on the previous conversation state and the new message state
      const prompt = await getReflectionPrompt(state, conversationState, message);
      
      const REFLECTION_LLM_PROVIDER = (process.env.STRUCTURED_LLM_PROVIDER as any) || "openai";
      const reflectionApiKey = process.env[`${REFLECTION_LLM_PROVIDER.toUpperCase()}_API_KEY`];
      
      if (!reflectionApiKey) {
        throw new Error(`${REFLECTION_LLM_PROVIDER.toUpperCase()}_API_KEY is not configured.`);
      }

      logger.info(`🔄 Reflection: Starting LLM request`, {
        provider: REFLECTION_LLM_PROVIDER,
        model: process.env.STRUCTURED_LLM_MODEL || "gpt-4o-mini",
        promptLength: prompt.length,
      });

      const response = await new LLM({
        name: REFLECTION_LLM_PROVIDER,
        apiKey: reflectionApiKey,
      }).createChatCompletion({
        model: process.env.STRUCTURED_LLM_MODEL || "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        maxTokens: 1024,
      });
      
      logger.info(`✅ Reflection: Received response`, {
        hasContent: !!response.content,
        contentLength: response.content?.length || 0,
        usage: response.usage,
        preview: response.content?.substring(0, 200) || "",
      });

      conversationState.values = {
        ...conversationState.values,
        ...JSON.parse(
          response.content.replace(/```json\n?/, "").replace(/\n?```$/, ""),
        ),
      };

      // temporary console logs
      logger.info(
        `New conversation state: ${JSON.stringify(conversationState.values)}`,
      );
    }

    // end step for reflection
    endStep(state, "REFLECTION");

    if (state.id) {
      try {
        await updateState(state.id, state.values);
      } catch (err) {
        console.error("Failed to update state in DB:", err);
      }
    }

    if (conversationState.id) {
      try {
        await updateConversationState(
          conversationState.id,
          conversationState.values,
        );
      } catch (err) {
        console.error("Failed to update conversation state in DB:", err);
      }
    }
  },
};
