// tools/chat-search.ts

import { z } from "zod";
import fuzzysort from "fuzzysort";
import { Message } from "../interfaces/message";

// Define the search parameters schema
export const SearchChatParams = z.object({
  query: z.string(),
  k: z.number().max(100).default(5).optional(),
  limit: z.number().max(100).default(100).optional(),
  user_only: z.boolean().default(false).optional(),
});
export type SearchChatParams = z.infer<typeof SearchChatParams>;

// Function to search chat messages
export async function search_chat(
  { query, k = 5, limit = 100, user_only = false }: SearchChatParams,
  context_message: Message
) {
  // Fetch recent messages from the current channel
  const messages = await context_message.fetchChannelMessages(limit);

  // Filter messages if user_only is true
  const filteredMessages = user_only
    ? messages.filter((msg) => msg.author.id === context_message.author.id)
    : messages;

  // Prepare list for fuzzysort
  const list = filteredMessages.map((msg) => ({
    message: msg,
    content: msg.content,
  }));

  // Perform fuzzy search on message contents
  const results = fuzzysort.go(query, list, { key: "content", limit: k });

  // Map results back to messages
  const matchedMessages = results.map((result) => {
    const matchedMessage = result.obj.message;
    return {
      content: matchedMessage.content,
      author: matchedMessage.author.username,
      timestamp: matchedMessage.timestamp,
      id: matchedMessage.id,
    };
  });

  return { results: matchedMessages };
}
