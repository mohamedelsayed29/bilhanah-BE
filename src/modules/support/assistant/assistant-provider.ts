import type { AssistantBlock, AssistantInput, AssistantMessage, SupportLanguage } from '@bilhanah/contracts';

/** What a provider knows about the conversation it answers. */
export type AssistantContext = {
  sessionId: string;
  language: SupportLanguage;
  userId: string;
  restaurantId: string;
  /** The latest messages, oldest first (for providers that need context, such as a future AI one). */
  history: AssistantMessage[];
};

/** A provider's answer: the blocks to show, and how to show the user's own step (e.g. the question picked). */
export type AssistantReply = { echo?: string; blocks: AssistantBlock[] };

/**
 * Something that answers the support assistant: the FAQ provider today, an AI provider later. Providers
 * only produce messages in the unified block format; sessions and storage belong to AssistantService,
 * and human support (tickets) is a separate module the UI reaches through a `handoff` block.
 */
export interface AssistantProvider {
  /** Stable name, stored on each session and message ("faq", later "ai"), and chosen by SUPPORT_ASSISTANT_PROVIDER. */
  readonly name: string;
  /** The first message of a new conversation. */
  welcome(context: AssistantContext): Promise<AssistantBlock[]>;
  respond(context: AssistantContext, input: AssistantInput): Promise<AssistantReply>;
}

/** Every registered provider (multi-provider injection token). */
export const ASSISTANT_PROVIDERS = Symbol('ASSISTANT_PROVIDERS');
