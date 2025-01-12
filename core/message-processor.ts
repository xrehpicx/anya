import { PlatformAdapter } from "../interfaces/platform-adapter";
import { Message, SentMessage } from "../interfaces/message";
import { getTools, zodFunction } from "../tools";
import OpenAI from "openai";
import { createHash } from "crypto";
import { format } from "date-fns";
import { saveApiUsage } from "../usage";
import { buildSystemPrompts } from "../assistant/system-prompts";
import YAML from "yaml";

import { ask, get_transcription } from "../tools/ask";
import { z } from "zod";
import { send_sys_log } from "../interfaces/log";

interface MessageQueueEntry {
  abortController: AbortController;
  runningTools: boolean;
}

export class MessageProcessor {
  private openai: OpenAI;
  private model: string = "gpt-4o";
  private messageQueue: Map<string, MessageQueueEntry> = new Map();
  private toolsCallMap: Map<string, OpenAI.Chat.ChatCompletionMessageParam[]> =
    new Map();
  private channelIdHashMap: Map<string, string[]> = new Map();
  private sentMessage: SentMessage | null = null;

  constructor(private adapter: PlatformAdapter) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
    });
  }

  private checkpointMessageString = "🔄 Chat context has been reset.";

  public async processMessage(message: Message): Promise<void> {
    const userId = message.author.id;
    const channelId = message.channelId || userId; // Use message.id if channelId is not available

    // Check if the message is a stop message
    if (["stop", "reset"].includes(message.content.toLowerCase())) {
      (await message.send({
        content: this.checkpointMessageString,
      }));
      // Clear maps
      const hashes = this.channelIdHashMap.get(channelId) ?? [];
      hashes.forEach((hash) => {
        this.toolsCallMap.delete(hash);
      });
      this.channelIdHashMap.set(channelId, []);
      return;
    }

    if (this.messageQueue.has(channelId)) {
      const queueEntry = this.messageQueue.get(channelId)!;
      if (!queueEntry.runningTools) {
        // Abort previous processing
        queueEntry.abortController.abort();
        this.messageQueue.delete(channelId);
      } else {
        // If tools are running, do not abort and return
        return;
      }
    }

    // Prepare OpenAI request
    const abortController = new AbortController();
    this.messageQueue.set(channelId, {
      abortController,
      runningTools: false,
    });

    // Handle timeout
    setTimeout(async () => {
      const queueEntry = this.messageQueue.get(channelId);
      if (queueEntry && !queueEntry.runningTools) {
        abortController.abort();
        this.messageQueue.delete(channelId);
        await message.send({ content: "Timed out." });
      }
    }, 600000); // 10 minutes

    try {
      // Indicate typing
      message.platformAdapter.config.indicators.typing &&
        (await message.sendTyping());

      // Fetch message history
      const history = await this.adapter.fetchMessages(channelId, {
        limit: 50,
      });

      // Send 'thinking...' indicator
      if (message.platformAdapter.config.indicators.processing)
        this.sentMessage = await message.send({ content: "thinking..." });

      // Check for stop message in history
      let stopIndex = -1;
      for (let i = 0; i < history.length; i++) {
        if (
          history[i].content === this.checkpointMessageString
        ) {
          stopIndex = i;
          break;
        }
      }
      const effectiveHistory =
        stopIndex !== -1 ? history.slice(0, stopIndex) : history;

      // Construct AI messages
      const aiMessages = await this.constructAIMessages(
        effectiveHistory,
        message,
        channelId
      );

      // Run tools and get AI response
      const response = await this.runAI(
        aiMessages as OpenAI.Chat.ChatCompletionMessage[],
        message.author.username,
        message,
        abortController,
        channelId
      );

      // Send reply via adapter
      if (response && !response.includes("<NOREPLY>")) {
        const content = this.isJsonParseable(response);
        if (content && content.user_message) {
          await message.send({ content: content.user_message });
        } else {
          await message.send({ content: response });
        }
      }

      // Delete the thinking message
      if (this.sentMessage && this.sentMessage.deletable) {
        await this.sentMessage.delete();
      } else if (this.sentMessage) {
        // If not deletable, edit the message to indicate completion
        await this.sentMessage.edit({ content: "Response sent." });
      }
    } catch (error) {
      console.error("Error processing message:", error);
      await this.sentMessage?.delete();
      // await message.send({
      //   content: "An error occurred while processing your message.",
      // });
    } finally {
      // Clean up
      this.messageQueue.delete(channelId);
    }
  }

  private async constructAIMessages(
    history: Message[],
    message: Message,
    channelId: string
  ): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    // Build system prompts based on user roles
    const systemMessages: OpenAI.Chat.ChatCompletionMessageParam[] =
      await buildSystemPrompts(message);

    // Map history messages to AI messages
    const channelHashes = this.channelIdHashMap.get(channelId) || [];

    const aiMessagesArrays = await Promise.all(
      history.reverse().map(async (msg) => {
        const role =
          msg.author.id === this.adapter.getBotId() ? "assistant" : "user";

        // Process attachments
        const files = (msg.attachments || [])
          .filter((a) => !a.url.includes("voice-message.ogg"))
          .map((a) => a.url);

        const embeds = (msg.embeds || [])
          .map((e) => JSON.stringify(e))
          .join("\n");

        console.log("Embeds", embeds?.length);
        console.log("Files", files?.length);
        console.log("Attachments", msg?.attachments?.length);

        // Transcribe voice messages
        const voiceMessagesPromises = (msg.attachments || [])
          .filter(
            (a) => a.url.includes("voice-message.ogg") || a.type === "ptt"
          )
          .map(async (a) => {
            const data =
              msg.platform === "whatsapp" ? (a.data as string) : a.url;
            const binary = msg.platform === "whatsapp";
            const key = msg.platform === "whatsapp" ? msg.id : undefined;
            return {
              file: a.url,
              transcription: await get_transcription(data, binary, key),
            };
          });

        const voiceMessages = await Promise.all(voiceMessagesPromises);

        console.log("Voice Messages", voiceMessages);

        const images = (msg.attachments || [])
          .filter((a) => a.mediaType?.includes("image"))

        // Process context message if any
        let contextMessage = null;
        if (msg.threadId) {
          contextMessage = history.find((m) => m.id === msg.threadId);
          // If not found, attempt to fetch it
          if (!contextMessage) {
            contextMessage = await this.adapter.fetchMessageById(
              channelId,
              msg.threadId
            );
          }
        }

        const contextAsJson = JSON.stringify({
          embeds: embeds || undefined,
          files: files.length > 0 ? files : undefined,
          user_message: msg.content,
          user_voice_messages:
            voiceMessages.length > 0 ? voiceMessages : undefined,
          created_at: format(msg.timestamp, "yyyy-MM-dd HH:mm:ss") + " IST",
          context_message: contextMessage
            ? {
              author: contextMessage.author.username,
              created_at:
                format(contextMessage.timestamp, "yyyy-MM-dd HH:mm:ss") +
                " IST",
              content: contextMessage.content,
            }
            : undefined,
          context_files:
            contextMessage?.attachments?.map((a) => a.url) || undefined,
          context_embeds:
            contextMessage?.embeds?.map((e) => JSON.stringify(e)).join("\n") ||
            undefined,
        });

        // get main user from userConfig
        const user = this.adapter.getUserById(msg.author.id);

        const aiMessage: OpenAI.Chat.ChatCompletionMessageParam = {
          role,
          content: (images.length ? [
            ...images.map(img => {
              return {
                type: "image_url",
                image_url: {
                  url: img.base64 || img.url,
                },
              }
            }),
            {
              type: "text",
              text: contextAsJson,
            }
          ] : contextAsJson) as string,
          name:
            user?.name ||
            msg.author.username.replace(/\s+/g, "_").substring(0, 64),
        };

        // Handle tool calls mapping if necessary
        const hash = this.generateHash(msg.content);
        const calls = this.toolsCallMap.get(hash);
        if (calls) {
          return [aiMessage, ...calls];
        } else {
          return [aiMessage];
        }
      })
    );

    // Flatten aiMessages (since it's an array of arrays)
    let aiMessages = aiMessagesArrays.flat();

    // Collect hashes
    history.forEach((msg) => {
      const hash = this.generateHash(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      channelHashes.push(hash);
    });

    // Update the channelIdHashMap
    this.channelIdHashMap.set(channelId, channelHashes);

    // If the conversation history is too long, summarize it
    if (aiMessages.length > 25) {
      aiMessages = await this.summarizeConversation(aiMessages);
    }

    // Combine system messages and conversation messages
    return systemMessages.concat(aiMessages);
  }

  private async summarizeConversation(
    messages: OpenAI.Chat.ChatCompletionMessageParam[]
  ): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    // Split the messages if necessary
    const lastTen = messages.slice(-10);
    const firstTen = messages.slice(0, 10);

    // Use the OpenAI API to generate the summary
    const summaryResponse = await ask({
      model: "gpt-4o-mini",
      prompt: `Summarize the below conversation into 2 sections:
1. General info about the conversation
2. Tools used in the conversation and their data in relation to the conversation.

Conversation:
----
${YAML.stringify(firstTen)}
----

Notes:
- Keep only important information and points, remove anything repetitive.
- Keep tools information if they are relevant.
- The summary is to give context about the conversation that was happening previously.
`,
    });

    const summaryContent = summaryResponse.choices[0].message.content;

    // Create a new conversation history with the summary
    const summarizedConversation: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `Previous messages summarized:
${summaryContent}
`,
      },
      ...lastTen,
    ];

    return summarizedConversation;
  }

  private async runAI(
    messages: OpenAI.Chat.ChatCompletionMessage[],
    username: string,
    message: Message,
    abortController: AbortController,
    channelId: string
  ): Promise<string> {
    const tmp = this;

    async function changeModel({ model }: { model: string }) {
      tmp.model = model;
      console.log("Model changed to", model);
      return { message: "Model changed to " + model };
    }

    // Use OpenAI to get a response, include tools integration
    const tools = getTools(username, message, "self");

    const toolCalls: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    console.log("Current Model", this.model);
    const runner = this.openai.beta.chat.completions
      .runTools(
        {
          model: this.model,
          temperature: 0.6,
          user: username,
          messages,
          stream: true,
          tools: [
            zodFunction({
              name: "changeModel",
              schema: z.object({
                model: z.string(z.enum(["gpt-4o-mini", "gpt-4o"])),
              }),
              function: changeModel,
              description: `Change the model at run time.
              Default Model is 'gpt-4o-mini'.
              Current Model: ${this.model}
              Switch to 'gpt-4o' before running any other tool.
              Try to switch back to 'gpt-4o-mini' after running tools.
              `,
            }),
            ...tools,
          ],
        },
        { signal: abortController.signal }
      )
      .on("functionCall", async (fnc) => {
        console.log("Function call:", fnc);
        // Set runningTools to true
        send_sys_log(`calling function: ${fnc.name}, in channel ${channelId}`);
        const queueEntry = this.messageQueue.get(channelId);

        if (queueEntry) {
          queueEntry.runningTools = true;
        }
        // Indicate running tools
        if (this.sentMessage?.platformAdapter.config.indicators.processing) {
          if (this.sentMessage) {
            await this.sentMessage.edit({ content: `Running ${fnc.name}...` });
          } else {
            this.sentMessage = await message.send({ content: `Running ${fnc.name}...` })
          }
        }
      })
      .on("message", (m) => {
        if (
          m.role === "assistant" &&
          (m.function_call || (m as any).tool_calls?.length)
        ) {
          toolCalls.push(m);
        }
        if (
          (m.role === "function" || m.role === "tool") &&
          ((m as any).function_call || (m as any).tool_call_id)
        ) {
          toolCalls.push(m);
        }
      })
      .on("error", (err) => {
        console.error("Error:", err);
        send_sys_log(`Error: ${err}, in channel ${channelId}`);
        if (this.sentMessage)
          this.sentMessage.edit({ content: "Error: " + JSON.stringify(err) });
        else message.send({ content: "Error: " + JSON.stringify(err) });
      })
      .on("abort", () => {
        send_sys_log(`Aborting in channel ${channelId}`);
        console.log("Aborted");
      })
      .on("totalUsage", (stat) => {
        send_sys_log(`Usage: ${JSON.stringify(stat)}, in channel ${channelId}`);
        saveApiUsage(
          format(new Date(), "yyyy-MM-dd"),
          this.model,
          stat.prompt_tokens,
          stat.completion_tokens
        );
      });

    const finalContent = await runner.finalContent();

    // Store tool calls in toolsCallMap
    const hash = this.generateHash(messages[messages.length - 1].content || "");
    this.toolsCallMap.set(hash, toolCalls);

    return finalContent ?? "";
  }

  private isJsonParseable(str: string) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return false;
    }
  }

  private generateHash(input: string): string {
    const hash = createHash("sha256");
    hash.update(typeof input === "string" ? input : JSON.stringify(input));
    return hash.digest("hex");
  }
}
