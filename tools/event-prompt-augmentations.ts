// event-prompt-augmentations.ts
import { RunnableToolFunctionWithParse } from "openai/lib/RunnableFunction.mjs";
import { get_transcription } from "./ask"; // or wherever your get_transcription function lives
import { Message } from "../interfaces/message";
import { buildSystemPrompts } from "../assistant/system-prompts";
import { getTools } from ".";

/**
 * The shape of data returned from any specialized event augmentation.
 */
export interface PromptAugmentationResult {
  additionalSystemPrompt?: string;
  updatedSystemPrompt?: string;
  message?: string;
  updatedTools?: RunnableToolFunctionWithParse<any>[];
  attachedImagesBase64?: string[]; // Changed to string array
  model: string;
}

/**
 * Helper function to handle transcription of a single file or array of files
 */
async function handleTranscription(
  input: File | File[]
): Promise<string | string[]> {
  if (Array.isArray(input)) {
    return Promise.all(
      input.map((file) => get_transcription(file as globalThis.File))
    );
  }
  return get_transcription(input as globalThis.File);
}

/**
 * 1) Voice Event Augmentation
 *    - Possibly do transcription if an audio File is present.
 *    - Possibly convert an image File to base64 if present.
 *    - Add any extra system prompt text needed for "voice mode."
 */
async function voiceEventAugmentation(
  payload: Record<string, any>,
  baseTools: RunnableToolFunctionWithParse<any>[] | undefined,
  contextMessage: Message
): Promise<PromptAugmentationResult> {
  let attachedImagesBase64: string[] = []; // Changed to array

  // Handle transcription - single file or array
  if (payload?.transcription) {
    if (
      payload.transcription instanceof File ||
      Array.isArray(payload.transcription)
    ) {
      console.log("Transcribing audio(s) for voice event listener.");
      payload.transcription = await handleTranscription(payload.transcription);
    }
  }

  // Handle other_reference_data - single file or array
  const otherContextData = payload?.other_reference_data;
  if (otherContextData) {
    if (Array.isArray(otherContextData)) {
      const results = await Promise.all(
        otherContextData.map(async (item) => {
          if (item instanceof File) {
            if (item.type.includes("audio")) {
              return await get_transcription(item as globalThis.File);
            } else if (item.type.includes("image")) {
              const buffer = await item.arrayBuffer();
              const imageBase64 = `data:${item.type};base64,${Buffer.from(
                buffer
              ).toString("base64")}`;
              attachedImagesBase64.push(imageBase64); // Add to array
              return imageBase64;
            }
          }
          return item;
        })
      );
      payload.other_reference_data = results;
    } else if (otherContextData instanceof File) {
      if (otherContextData.type.includes("audio")) {
        payload.other_reference_data = await get_transcription(
          otherContextData as globalThis.File
        );
      } else if (otherContextData.type.includes("image")) {
        const buffer = await otherContextData.arrayBuffer();
        const imageBase64 = `data:${otherContextData.type};base64,${Buffer.from(
          buffer
        ).toString("base64")}`;
        attachedImagesBase64.push(imageBase64); // Add to array
      }
    }
  }

  const files = payload?.files;
  if (files) {
    if (Array.isArray(files)) {
      const results = await Promise.all(
        files.map(async (file) => {
          if (file instanceof File) {
            if (file.type.includes("audio")) {
              const res = await get_transcription(file as globalThis.File);
              return `transcript of file: ${file.name}:
              
              ${res}
              `
            } else if (file.type.includes("image")) {
              const buffer = await file.arrayBuffer();
              const imageBase64 = `data:${file.type};base64,${Buffer.from(
                buffer
              ).toString("base64")}`;
              attachedImagesBase64.push(imageBase64); // Add to array
              return `image file: ${file.name}`;
            }
          }
          return file;
        })
      );
      payload.files = results;
    } else if (files instanceof File) {
      if (files.type.includes("audio")) {
        // payload.files = await get_transcription(files as globalThis.File);
        const res = await get_transcription(files as globalThis.File);
        payload.files = `transcript of file: ${files.name}:

        ${res}
        `;

      } else if (files.type.includes("image")) {
        const buffer = await files.arrayBuffer();
        const imageBase64 = `data:${files.type};base64,${Buffer.from(
          buffer
        ).toString("base64")}`;
        attachedImagesBase64.push(imageBase64); // Add to array
        payload.files = `image file: ${files.name}`;
      }
    }
  }

  // console.log("Payload: ", payload);
  // console.log("IMages: ", attachedImagesBase64);

  let message = `
You are in voice trigger mode.

The voice event that triggered this is:
Payload: ${JSON.stringify(payload, null, 2)}

Your response must be in plain text without extra formatting or Markdown.
`;

  const systemPrompts = await buildSystemPrompts(contextMessage);

  const prompt = systemPrompts.map((p) => p.content).join("\n\n");

  const tools = getTools(
    contextMessage.author.username,
    contextMessage
  ) as RunnableToolFunctionWithParse<any>[];

  return {
    updatedSystemPrompt: prompt,
    message,
    updatedTools: tools,
    attachedImagesBase64, // Now returning array
    model: "gpt-4o",
  };
}

/**
 * 2) New Todo Note Event Augmentation
 */
async function newTodoAugmentation(
  payload: Record<string, any>,
  baseTools: RunnableToolFunctionWithParse<any>[] | undefined,
  contextMessage: Message
): Promise<PromptAugmentationResult> {
  let message = `
You are in new todo note trigger mode.

The user added a new todo note which triggered this event.
Payload: ${JSON.stringify(payload, null, 2)}

Make sure to handle the user's newly added todo item.
IMPORTANT: Mark the todo as done if appropriate, etc.
`;

  let systemPrompts = await buildSystemPrompts(contextMessage);

  const prompt = systemPrompts.map((p) => p.content).join("\n\n");

  const tools = getTools(
    contextMessage.author.username,
    contextMessage
  ) as RunnableToolFunctionWithParse<any>[];

  return {
    additionalSystemPrompt: prompt,
    message,
    updatedTools: tools,
    model: "gpt-4o-mini",
  };
}

/**
 * 3) Message from a Manager Event Augmentation
 */
async function messageFromManagerAugmentation(
  payload: Record<string, any>,
  baseTools: RunnableToolFunctionWithParse<any>[] | undefined,
  contextMessage: Message
): Promise<PromptAugmentationResult> {
  const message = `
You just got a request from a manager.

Payload: ${JSON.stringify(payload, null, 2)}

Handle it accordingly.
`;
  const tools = getTools(
    contextMessage.author.username,
    contextMessage
  ) as RunnableToolFunctionWithParse<any>[];
  return {
    message,
    updatedTools: tools,
    model: "gpt-4o-mini",
  };
}

/**
 * 4) Default/Fallback Augmentation
 */
async function defaultAugmentation(
  payload: Record<string, any>,
  baseTools: RunnableToolFunctionWithParse<any>[] | undefined
): Promise<PromptAugmentationResult> {
  return {
    updatedTools: baseTools,
    attachedImagesBase64: [], // Changed to empty array
    model: "gpt-4o-mini",
  };
}

/**
 * A map/dictionary that returns specialized logic keyed by `eventId`.
 * If no exact eventId match is found, we will fallback to `defaultAugmentation`.
 */
export const eventPromptAugmentations: Record<
  string,
  (
    payload: Record<string, any>,
    baseTools: RunnableToolFunctionWithParse<any>[] | undefined,
    contextMessage: Message
  ) => Promise<PromptAugmentationResult>
> = {
  on_voice_message: voiceEventAugmentation,
  new_todo_for_anya: newTodoAugmentation,
  message_from_a_manager: messageFromManagerAugmentation,
  // Add more eventId-specific augmentations as needed...
};

/**
 * Builds the final prompt and attaches any relevant tooling or attachments
 * for a given event and instruction. Consolidates the "branching logic" into
 * modular augmentations, removing scattered if/else from the main file.
 */
export async function buildPromptAndToolsForEvent(
  eventId: string,
  description: string,
  payload: Record<string, any>,
  instruction: string,
  notify: boolean,
  baseTools: RunnableToolFunctionWithParse<any>[] | undefined,
  contextMessage: Message
): Promise<{
  finalPrompt: string;
  message?: string;
  finalTools: RunnableToolFunctionWithParse<any>[] | undefined;
  attachedImages?: string[];
  model?: string;
}> {
  console.log(`Building prompt for event: ${eventId}`);
  console.log(`Instruction: ${instruction}`);
  console.log(`Payload: ${JSON.stringify(payload, null, 2)}`);

  // 1) A base system prompt shared by all "instruction" type listeners
  const baseSystemPrompt = `You are an Event Handler.
You are called when an event triggers. Your task is to execute the user's instruction based on the triggered event and reply with the text to display as a notification to the user.

**Guidelines:**

- **Notification to User:**
  - Any message you reply with will automatically be sent to the user as a notification.
  - Do **not** indicate in the text that it is a notification.

- **Using Tools:**
  - You have access to the necessary tools to execute the instruction; use them as needed.
  - You also have access to the \`event_manager\` tool if you need to manage events or listeners (use it only if necessary).

- **Sending Messages:**
  - **To the Current User:**  
    - Do **not** ask \`communication_manager\` tool.
    - Simply reply with the message you want to send.
  - **To Other Users:**  
    - Use the \`communication_manager\` tool.
    - The message you reply with will still be sent to the current user as a notification.

**Example:**

- **Instruction:** "When you get an email from John, tell John on WhatsApp that you got the email."
- **Steps:**
  1. Use the \`communication_manager\` tool to send a message to John on WhatsApp.
  2. Reply to the current user with "I have sent a message to John on WhatsApp that you got the email."

**Currently Triggered Event:**
- **Event ID:** ${eventId}
- **Description:** ${description}
- **Payload:** ${JSON.stringify(payload, null, 2)}
- **Will Auto Notify Creator of Listener:** ${notify
      ? "Yes, no need to send it yourself"
      : "No, you need to notify the user manually"
    }
- **Instruction:** ${instruction}

**Action Required:**
- Follow the instruction provided in the payload.
- Return the notification text based on the instruction.

**Important Note:**
- If the event and payload do **not** match the instruction, reply with **"IGNORE"**.
`;

  // 2) Decide which augmentation function to call
  let augmentationFn = eventPromptAugmentations[eventId];
  if (!augmentationFn) {
    // Example: if your eventId is "message_from_xyz", handle it as a manager augmentation
    if (eventId.startsWith("message_from")) {
      augmentationFn = messageFromManagerAugmentation;
    } else {
      augmentationFn = defaultAugmentation;
    }
  }

  // 3) Run the specialized augmentation
  const {
    additionalSystemPrompt,
    updatedTools,
    attachedImagesBase64,
    updatedSystemPrompt,
    model,
    message,
  } = await augmentationFn(payload, baseTools, contextMessage);

  // 4) Combine prompts
  const finalPrompt = [baseSystemPrompt, additionalSystemPrompt]
    .filter(Boolean)
    .join("\n\n");

  return {
    finalPrompt: updatedSystemPrompt || finalPrompt,
    finalTools: updatedTools,
    attachedImages: attachedImagesBase64,
    model,
    message,
  };
}
