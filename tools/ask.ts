import OpenAI from "openai";
import { saveApiUsage } from "../usage";
import axios from "axios";
import fs from "fs";
import { RunnableToolFunctionWithParse } from "openai/lib/RunnableFunction.mjs";
import {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
} from "openai/resources/index.mjs";
import { send_sys_log } from "../interfaces/log";
import { pathInDataDir } from "../config";

const ai_token = process.env.OPENAI_API_KEY?.trim();
const groq_token = process.env.GROQ_API_KEY?.trim();
const groq_baseurl = process.env.GROQ_BASE_URL?.trim();

// Messages saving implementation

interface MessageHistory {
  messages: ChatCompletionMessageParam[];
  timeout: NodeJS.Timer;
}

const seedMessageHistories: Map<string, MessageHistory> = new Map();
const HISTORY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Retrieves the message history for a given seed.
 * If it doesn't exist, initializes a new history.
 * Resets the timeout each time it's accessed.
 *
 * @param seed - The seed identifier for the message history
 * @returns The message history array
 */
function getMessageHistory(seed: string): ChatCompletionMessageParam[] {
  const existingHistory = seedMessageHistories.get(seed);

  if (existingHistory) {
    // Reset the timeout
    clearTimeout(existingHistory.timeout);
    existingHistory.timeout = setTimeout(() => {
      seedMessageHistories.delete(seed);
      console.log(`Cleared message history for seed: ${seed}`);
      send_sys_log(`Cleared message history for seed: ${seed}`);
    }, HISTORY_TIMEOUT_MS);

    return existingHistory.messages;
  } else {
    // Initialize new message history
    const messages: ChatCompletionMessageParam[] = [];
    const timeout = setTimeout(() => {
      seedMessageHistories.delete(seed);
      console.log(`Cleared message history for seed: ${seed}`);
      send_sys_log(`Cleared message history for seed: ${seed}`);
    }, HISTORY_TIMEOUT_MS);

    seedMessageHistories.set(seed, { messages, timeout });
    return messages;
  }
}

/**
 * Sets the entire message history for a given seed.
 *
 * @param seed - The seed identifier for the message history
 * @param messages - The complete message history to set
 */
function setMessageHistory(
  seed: string,
  messages: ChatCompletionMessageParam[]
): void {
  const existingHistory = seedMessageHistories.get(seed);
  if (existingHistory) {
    clearTimeout(existingHistory.timeout);
    existingHistory.messages = messages;
    existingHistory.timeout = setTimeout(() => {
      seedMessageHistories.delete(seed);
      console.log(`Cleared message history for seed: ${seed}`);
      send_sys_log(`Cleared message history for seed: ${seed}`);
    }, HISTORY_TIMEOUT_MS);
  } else {
    const timeout = setTimeout(() => {
      seedMessageHistories.delete(seed);
      console.log(`Cleared message history for seed: ${seed}`);
      send_sys_log(`Cleared message history for seed: ${seed}`);
    }, HISTORY_TIMEOUT_MS);
    seedMessageHistories.set(seed, { messages, timeout });
  }
}

/**
 * Appends a message to the message history for a given seed.
 *
 * @param seed - The seed identifier for the message history
 * @param message - The message to append
 */
function appendMessage(
  seed: string,
  message: ChatCompletionMessageParam
): void {
  console.log(
    "Appending message",
    message.content,
    "tool_calls" in message && message.tool_calls
  );

  const history = seedMessageHistories.get(seed);
  if (history) {
    history.messages.push(message);
    // Reset the timeout
    clearTimeout(history.timeout);
    history.timeout = setTimeout(() => {
      seedMessageHistories.delete(seed);
      send_sys_log(`Cleared message history for seed: ${seed}`);
      console.log(`Cleared message history for seed: ${seed}`);
    }, HISTORY_TIMEOUT_MS);
  }
}

/**
 * The updated ask function with support for persistent message history via a seed.
 * Separates system prompt and user message to prevent duplication.
 *
 * @param params - The parameters for the ask function
 * @returns The response from the LLM API
 */
export async function ask({
  model = "gpt-4o-mini",
  prompt, // System prompt
  message, // User input message (optional)
  name,
  tools,
  seed,
}: {
  model?: string;
  prompt: string;
  message?: string;
  name?: string;
  tools?: RunnableToolFunctionWithParse<any>[];
  seed?: string;
}): Promise<ChatCompletion> {
  // Initialize OpenAI instances
  const openai = new OpenAI({
    apiKey: ai_token,
  });

  const groq = new OpenAI({
    apiKey: groq_token,
    baseURL: groq_baseurl,
  });

  // Initialize messages array with the system prompt
  let messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: prompt,
    },
  ];

  if (seed && message) {
    // Retrieve existing message history
    const history = getMessageHistory(seed);

    // Combine system prompt with message history and new user message
    messages = [
      {
        role: "system",
        content: prompt,
      },
      ...history,
      {
        role: "user",
        content: message,
        name,
      },
    ];
  } else if (seed && !message) {
    // If seed is provided but no new message, just retrieve history
    const history = getMessageHistory(seed);
    messages = [
      {
        role: "system",
        content: prompt,
      },
      ...history,
    ];
  } else if (!seed && message) {
    // If no seed but message is provided, send system prompt and user message without history
    messages.push({
      role: "user",
      content: message,
      name,
    });
  }

  let res: ChatCompletion;

  if (model === "groq-small") {
    res = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages,
    });

    if (res.usage) {
      saveApiUsage(
        new Date().toISOString().split("T")[0],
        model,
        res.usage.prompt_tokens,
        res.usage.completion_tokens
      );
    } else {
      console.log("No usage data");
    }

    // Handle response with seed
    if (seed && res.choices && res.choices.length > 0) {
      appendMessage(seed, res.choices[0].message);
    }

    return res;
  }

  if (tools?.length) {
    // Create a new runner with the current messages and tools
    const runner = openai.beta.chat.completions
      .runTools({
        model,
        messages,
        tools,
      })
      .on("functionCall", (functionCall) => {
        send_sys_log(`ASK Function call: ${JSON.stringify(functionCall)}`);
        console.log("ASK Function call:", functionCall);
      })
      .on("message", (message) => {
        // remove empty tool_calls array
        if (
          "tool_calls" in message &&
          message.tool_calls &&
          message.tool_calls.length === 0
        ) {
          message.tool_calls = undefined;
          delete message.tool_calls;
        }
        seed && appendMessage(seed, message);
      })
      .on("totalUsage", (usage) => {
        send_sys_log(
          `ASK Total usage: ${usage.prompt_tokens} prompt tokens, ${usage.completion_tokens} completion tokens`
        );
        console.log("ASK Total usage:", usage);
        saveApiUsage(
          new Date().toISOString().split("T")[0],
          model,
          usage.prompt_tokens,
          usage.completion_tokens
        );
      });

    // Await the final chat completion
    res = await runner.finalChatCompletion();

    return res;
  }

  // Default behavior without tools
  res = await openai.chat.completions.create({
    model,
    messages,
  });

  if (res.usage) {
    saveApiUsage(
      new Date().toISOString().split("T")[0],
      model,
      res.usage.prompt_tokens,
      res.usage.completion_tokens
    );
  } else {
    console.log("No usage data");
  }

  // Handle response with seed
  if (seed && res.choices && res.choices.length > 0) {
    const assistantMessage = res.choices[0].message;
    appendMessage(seed, assistantMessage);
  }

  return res;
}

const transcriptionCacheFile = pathInDataDir("transcription_cache.json");

export async function get_transcription(
  file_url: string,
  binary?: boolean,
  key?: string
) {
  const openai = new OpenAI({
    apiKey: ai_token,
  });

  // Step 1: Check if the transcription for this file URL is already cached
  let transcriptionCache: Record<string, string> = {};

  // Try to read the cache file if it exists
  if (fs.existsSync(transcriptionCacheFile)) {
    const cacheData = fs.readFileSync(transcriptionCacheFile, "utf-8");
    transcriptionCache = JSON.parse(cacheData);
  }

  if (binary) {
    // If transcription for this file_url is already in the cache, return it
    if (key && transcriptionCache[key]) {
      console.log("Transcription found in cache:", transcriptionCache[key]);
      return transcriptionCache[key];
    }

    const binaryData = Buffer.from(file_url, "base64");
    // fs.writeFile("/home/audio_whats.ogg", binaryData, function (err) {});

    const filePath = `/tmp/audio${Date.now()}.ogg`;

    fs.writeFileSync(filePath, new Uint8Array(binaryData));

    // Step 3: Send the file to OpenAI's Whisper model
    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(filePath),
    });

    // Delete the temp file
    fs.unlinkSync(filePath);

    // Step 4: Save the transcription to the cache
    key && (transcriptionCache[key] = transcription.text);
    fs.writeFileSync(
      transcriptionCacheFile,
      JSON.stringify(transcriptionCache, null, 2)
    );

    console.log("Transcription:", transcription);

    return transcription.text;
  }

  // If transcription for this file_url is already in the cache, return it
  if (transcriptionCache[file_url]) {
    console.log("Transcription found in cache:", transcriptionCache[file_url]);
    return transcriptionCache[file_url];
  }

  try {
    // Step 2: Download the file from the URL
    const response = await axios({
      url: file_url,
      method: "GET",
      responseType: "stream",
    });

    const filePath = `/tmp/audio${Date.now()}.ogg`;

    // Save the downloaded file locally
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    // Step 3: Send the file to OpenAI's Whisper model
    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(filePath),
    });

    // Delete the temp file
    fs.unlinkSync(filePath);

    // Step 4: Save the transcription to the cache
    transcriptionCache[file_url] = transcription.text;
    fs.writeFileSync(
      transcriptionCacheFile,
      JSON.stringify(transcriptionCache, null, 2)
    );

    console.log("Transcription:", transcription);
    return transcription.text;
  } catch (error) {
    console.error("Error transcribing audio:", error);
  }
}
