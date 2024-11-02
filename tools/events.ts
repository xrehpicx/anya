// event_tools.ts
import YAML from "yaml";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { Message } from "../interfaces/message";
import { eventManager } from "../interfaces/events";
import fs from "fs/promises";
import path from "path";
import { discordAdapter } from "../interfaces";
import { RunnableToolFunctionWithParse } from "openai/lib/RunnableFunction.mjs";
import { getTools, zodFunction } from ".";
import { ask, get_transcription } from "./ask";
import { get_actions } from "./actions";
import { pathInDataDir, userConfigs } from "../config";
import { memory_manager_guide, memory_manager_init } from "./memory-manager";
import { buildSystemPrompts } from "../assistant/system-prompts";

// Paths to the JSON files
const LISTENERS_FILE_PATH = pathInDataDir("listeners.json");
const EVENTS_FILE_PATH = pathInDataDir("events.json");

// Define schema for creating an event
export const CreateEventParams = z.object({
  eventId: z
    .string()
    .describe(
      "The unique identifier for the event. Make this relevant to the event."
    ),
  description: z
    .string()
    .min(1, "description is required")
    .describe("Short description of the event."),
});

// Type for creating an event
export type CreateEventParams = z.infer<typeof CreateEventParams>;

// Define schema for creating an event listener
export const CreateEventListenerParams = z
  .object({
    eventId: z.string().min(1, "eventId is required"),
    description: z
      .string()
      .min(1, "description is required")
      .describe("Short description of what the event listener does."),
    instruction: z
      .string()
      .min(1, "instruction is required")
      .describe(
        "Detailed instructions on what to do with the event payload when triggered."
      )
      .optional(),
    template: z
      .string()
      .min(1, "template is required")
      .describe(
        "A string template to format the event payload. Use double curly braces to reference payload variables, e.g., {{variableName}}."
      )
      .optional(),
    tool_names: z
      .array(z.string())
      .optional()
      .describe(
        `Names of the tools required to execute the instruction when the event is triggered.
        Each of these should look something like "home_assistant_manager" or "calculator" and NOT "function:home_assistant_manager" or "function.calculator".`
      ),
    autoStopAfterSingleEvent: z
      .boolean()
      .default(true)
      .describe(
        `Auto stop after the first event is triggered. Defaults to true. Cannot be set with autoStopAfterDelay.`
      )
      .optional(),
    autoStopAfterDelay: z
      .number()
      .positive()
      .int()
      .optional()
      .describe(
        "Time in seconds after which the listener auto stops. Cannot be set with autoStopAfterSingleEvent."
      ),
    notify: z
      .boolean()
      .describe(
        "Whether to notify the user or not, should be true by default."
      ),
  })
  .refine(
    (data) => {
      const hasInstruction = !!data.instruction;
      const hasTemplate = !!data.template;
      return hasInstruction !== hasTemplate; // Either instruction or template must be present, but not both
    },
    {
      message:
        "Either 'instruction' or 'template' must be provided, but not both.",
    }
  );

// Type for creating an event listener
export type CreateEventListenerParams = z.infer<
  typeof CreateEventListenerParams
>;

// Define schema for searching event listeners
export const SearchEventListenersParams = z.object({
  userId: z.string().optional(),
  eventId: z.string().optional(),
});

// Type for searching event listeners
export type SearchEventListenersParams = z.infer<
  typeof SearchEventListenersParams
>;

// Define schema for removing an event listener
const RemoveEventListenerParamsSchema = z.object({
  listenerId: z.string().min(1, "listenerId is required"),
});

// Type for removing an event listener
type RemoveEventListenerParams = z.infer<
  typeof RemoveEventListenerParamsSchema
>;

/**
 * Removes an event listener by its listenerId by fully deleting it.
 * @param params - Parameters containing the listenerId.
 * @returns A JSON object confirming removal or an error.
 */
export async function remove_event_listener_tool(
  params: RemoveEventListenerParams
): Promise<any> {
  // Validate parameters using zod
  const parsed = RemoveEventListenerParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { error: parsed.error.errors };
  }

  const { listenerId } = parsed.data;

  const listener = listenersMap.get(listenerId);

  if (!listener) {
    return {
      error: `❌ Listener with ID "${listenerId}" not found.`,
    };
  }

  // Fully remove the listener
  await removeListener(listener.id, listener.eventId);

  return {
    message: `✅ Listener with ID "${listenerId}" removed successfully.`,
  };
}

// Define schema for updating event description
export const UpdateEventDescriptionParams = z.object({
  eventId: z.string().min(1, "eventId is required"),
  description: z.string().min(1, "description is required"),
});

// Type for updating event description
export type UpdateEventDescriptionParams = z.infer<
  typeof UpdateEventDescriptionParams
>;

// Define schema for updating an event listener
export const UpdateEventListenerParams = z
  .object({
    listenerId: z.string().min(1, "listenerId is required"),
    eventId: z.string().min(1, "eventId is required"),
    description: z.string().min(1, "description is required"),
    instruction: z
      .string()
      .min(1, "instruction is required")
      .describe(
        "Detailed instructions on what to do with the event payload when triggered."
      )
      .optional(),
    template: z
      .string()
      .min(1, "template is required")
      .describe(
        "A string template to format the event payload. Use double curly braces to reference payload variables, e.g., {{variableName}}."
      )
      .optional(),
    tool_names: z
      .array(z.string())
      .optional()
      .describe(
        "Names of the tools required to execute the instruction when the event is triggered."
      ),
    autoStopAfterSingleEvent: z
      .boolean()
      .optional()
      .describe(
        `Auto stop after the first event is triggered. Cannot be set with autoStopAfterDelay.`
      ),
    autoStopAfterDelay: z
      .number()
      .positive()
      .int()
      .optional()
      .describe(
        "Time in seconds after which the listener auto stops. Cannot be set with autoStopAfterSingleEvent."
      ),
  })
  .refine(
    (data) => {
      const hasInstruction = !!data.instruction;
      const hasTemplate = !!data.template;
      return hasInstruction !== hasTemplate; // Either instruction or template must be present, but not both
    },
    {
      message:
        "Either 'instruction' with 'tool_names' or 'template' must be provided, but not both.",
    }
  );

// Type for updating an event listener
export type UpdateEventListenerParams = z.infer<
  typeof UpdateEventListenerParams
>;

// Define the structure of an Event
interface Event {
  eventId: string;
  description: string;
  userId: string; // Associate the event with a user
  setup_done: boolean; // Added field to indicate if setup is done
  last_triggered?: string; // ISO string for serialization
  last_payload?: Record<string, any>; // Store the last payload
}

// Define the structure of an Event Listener
interface EventListener {
  id: string;
  eventId: string;
  userId: string;
  description: string;
  instruction?: string;
  template?: string; // New field for static event listeners
  options: ListenerOptions;
  tool_names?: string[];
  created_at: string; // ISO string for serialization
  expires_in?: number; // seconds
  callback?: EventCallback; // Not serialized
  notify: boolean;
}

// Options for listener
interface ListenerOptions {
  autoStopAfterSingleEvent?: boolean;
  autoStopAfterDelay?: number; // seconds
}

// Define the type for the event callback
type EventCallback = (payload: Record<string, string | number>) => void;

// In-memory storage for events and event listeners
const eventsMap: Map<string, Event> = new Map();
const listenersMap: Map<string, EventListener> = new Map();

// Helper function to load events from the JSON file
async function loadEventsFromFile() {
  try {
    const data = await fs.readFile(EVENTS_FILE_PATH, "utf-8");
    const parsed = JSON.parse(data) as Event[];
    parsed.forEach((event) => {
      eventsMap.set(event.eventId, event);
    });
    console.log(`✅ Loaded ${eventsMap.size} events from ${EVENTS_FILE_PATH}`);
  } catch (error: any) {
    if (error.code === "ENOENT") {
      // File does not exist, create an empty file
      await saveEventsToFile();
      console.log(`📄 Created new events file at ${EVENTS_FILE_PATH}`);
    } else {
      console.error(`❌ Failed to load events from file: ${error.message}`);
    }
  }
}

// Helper function to save events to the JSON file
async function saveEventsToFile() {
  const data = JSON.stringify(Array.from(eventsMap.values()), null, 2);
  await fs.writeFile(EVENTS_FILE_PATH, data, "utf-8");
}

// Helper function to load listeners from the JSON file
async function loadListenersFromFile() {
  try {
    const data = await fs.readFile(LISTENERS_FILE_PATH, "utf-8");
    const parsed = JSON.parse(data) as EventListener[];
    parsed.forEach((listener) => {
      // Check if listener has expired
      if (listener.expires_in) {
        const createdAt = new Date(listener.created_at).getTime();
        const expiresInMs = listener.expires_in * 1000;
        const currentTime = Date.now();
        if (currentTime > createdAt + expiresInMs) {
          console.log(
            `🔕 Listener "${listener.id}" for event "${listener.eventId}" by user "${listener.userId}" has expired and will not be loaded.`
          );
          return; // Skip loading expired listener
        }
      }

      listenersMap.set(listener.id, listener);
      registerListener(listener);
    });
    console.log(
      `✅ Loaded ${listenersMap.size} listeners from ${LISTENERS_FILE_PATH}`
    );
  } catch (error: any) {
    if (error.code === "ENOENT") {
      // File does not exist, create an empty file
      await saveListenersToFile();
      console.log(`📄 Created new listeners file at ${LISTENERS_FILE_PATH}`);
    } else {
      console.error(`❌ Failed to load listeners from file: ${error.message}`);
    }
  }
}

// Helper function to save listeners to the JSON file
async function saveListenersToFile() {
  const data = JSON.stringify(Array.from(listenersMap.values()), null, 2);
  await fs.writeFile(LISTENERS_FILE_PATH, data, "utf-8");
}

/**
 * Replaces placeholders in the format {{key}} in the template with corresponding values from the provided record.
 * If the value is not a string, it will JSON stringify it before inserting.
 *
 * @param template - The string template containing placeholders like {{key}}.
 * @param data - The record containing key-value pairs for replacement.
 * @returns The formatted string with placeholders replaced by data values.
 */
function replacePlaceholders(
  template: string,
  data: Record<string, any>
): string {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (_, key) => {
    const value = data[key.trim()];
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

// Function to register a listener with the eventManager
function registerListener(listener: EventListener) {
  const { eventId, description, userId, options, tool_names, notify } =
    listener;

  const callback: EventCallback = async (
    payload: Record<string, string | number>
  ) => {
    const event = eventsMap.get(eventId);
    if (event) {
      event.last_triggered = new Date().toISOString();
      event.last_payload = payload;
      await saveEventsToFile();
    }
    try {
      // Check if listener has expired
      if (listener.expires_in) {
        const createdAt = new Date(listener.created_at).getTime();
        const expiresInMs = listener.expires_in * 1000;
        const currentTime = Date.now();
        if (currentTime > createdAt + expiresInMs) {
          console.log(
            `🔕 Listener "${listener.id}" for event "${eventId}" by user "${userId}" has expired and will be removed.`
          );
          await removeListener(listener.id, eventId);
          return; // Ignore trigger
        }
      }

      // Recreate the Message instance using discordAdapter
      const contextMessage: Message =
        await discordAdapter.createMessageInterface(userId);
      if (!contextMessage) {
        console.error(
          `❌ Unable to create Message interface for user "${userId}".`
        );
        return;
      }

      if (listener.template) {
        // Handle static event listener with template
        const formattedMessage = renderTemplate(listener.template, payload);
        await contextMessage.send({ content: formattedMessage });

        // Handle auto-stop options
        if (options.autoStopAfterSingleEvent) {
          await removeListener(listener.id, eventId);
        }
        return formattedMessage;
        // Expiry is handled via periodic cleanup
      } else if (listener.instruction) {
        // Handle dynamic event listener with instruction and tools
        const u_tool_names = Array.from(
          new Set([...(tool_names ?? []), "event_manager"])
        );
        let tools = getTools(
          contextMessage.author.username,
          contextMessage
        ).filter(
          (tool) =>
            tool.function.name && u_tool_names?.includes(tool.function.name)
        ) as RunnableToolFunctionWithParse<any>[] | undefined;

        tools = tools?.length ? tools : undefined;

        const is_voice = listener.eventId === "on_voice_message";
        const is_new_todo_note = listener.eventId === "new_todo_for_anya";
        const is_message_from_a_manager =
          listener.eventId.startsWith("message_from");

        let attached_image: string | undefined = undefined;

        if (is_voice || is_new_todo_note || is_message_from_a_manager) {
          tools = getTools(
            contextMessage.author.username,
            contextMessage
          ) as RunnableToolFunctionWithParse<any>[];
        }
        if (is_voice) {
          const audio = ((payload as any) ?? {}).transcription;
          if (audio && audio instanceof File) {
            if (audio.type.includes("audio")) {
              console.log("Transcribing audio for voice event listener.");
              (payload as any).transcription = await get_transcription(
                audio as File
              );
            }
          }

          console.log("Payload for voice event listener: ", payload);
          const otherContextData = (payload as any)?.other_reference_data;

          if (otherContextData instanceof File) {
            if (otherContextData.type.includes("image")) {
              console.log("Got image");
              // Read the file as a buffer
              const buffer = await otherContextData.arrayBuffer();

              // Convert the buffer to a base64 string
              const base64Url = `data:${
                otherContextData.type
              };base64,${Buffer.from(buffer).toString("base64")}`;

              // Do something with imageObject, like sending it in a response or logging
              attached_image = base64Url;
            } else {
              console.log("The provided file is not an image.");
            }
          } else {
            console.log(
              "No valid file provided in other_context_data.",
              otherContextData?.name,
              otherContextData?.type
            );
          }
        }

        console.log("Running ASK for event listener: ", listener.description);

        const system_prompts =
          is_voice || is_new_todo_note || is_message_from_a_manager
            ? await buildSystemPrompts(contextMessage)
            : undefined;

        const prompt_heading = system_prompts
          ? ""
          : `You are an Event Handler.`;

        let prompt = `${prompt_heading}
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
              - Do **not** ask \`communication_manager\` tool. (if available)
              - Simply reply with the message you want to send.
            - **To Other Users:**
              - Use the \`communication_manager\` tool. (if available)
              - The message you reply with will still be sent to the current user as a notification.
          
          **Example:**
          
          - **Instruction:** "When you get an email from John, tell John on WhatsApp that you got the email."
          - **Steps:**
            1. Use the \`communication_manager\` tool to send a message to John on WhatsApp.
               - Use the WhatsApp ID from the payload to send the message instead of searching for the user.
            2. Reply to the current user with "I have sent a message to John on WhatsApp that you got the email."
          
          **Currently Triggered Event:**
          
          - **Event ID:** ${eventId}
          - **Description:** ${description}
          - **Payload:** ${JSON.stringify(payload)}
          - **Will Auto Notify Creator of Listener:** ${notify ? "Yes" : "No"}
          - **Instruction:** ${listener.instruction}
          
          **Action Required:**          
          - Follow the instruction provided in the payload.
          - Return the notification text based on the instruction.

          **Important Note:**
          - If the above event and payload does **not** match the instruction, reply with the string **"IGNORE"** to skip executing the instruction for this payload.
          
          `;

        const voice_prompt = `You are in voice trigger mode.

          The voice event that triggered this is:
          - Event ID: ${eventId}
          - Listener Description: ${description}
          - Payload: ${JSON.stringify(payload)}
          
          Do the instruction provided in the payload of the event listener.
          
          Your response must be in plain text without markdown or any other formatting.
          `;

        const new_todo_note_prompt = `You are in new todo note trigger mode.
        
        The user added a new todo note for you in your todos file which triggered this event.

        Do not remove the to anya tag from the note if its present, unless explicitly asked to do so as part of the instruction.

        Make sure to think about your process and how you want to step by step go about executing the todos.

        You can mark a todo as failed by adding "[FAILED]" at the start of end of the todo line.
        
        - Event ID: ${eventId}
        - Payload: ${JSON.stringify(payload)}
        
        IMPORTANT: 
        PLEASE ask notes manager to mark the note as done if you have completed the task, plz send the manager the todo note and the actual path of the note.
        Whatever you reply with will be sent to the user as a notification automatically. Do not use communication_manager to notify the same user.
        `;

        const message_from_manager_prompt = `You just got a request from a manager.

        The manager has sent you a message which triggered this event.

        - Event ID: ${eventId}
        - Payload: ${JSON.stringify(payload)}
`;

        if (system_prompts) {
          prompt = `${system_prompts.map((p) => p.content).join("\n\n")}`;
        }

        let promptToUse = prompt;
        let seed = `${listener.id}-${eventId}`;

        if (is_voice) {
          promptToUse = voice_prompt;
          seed = `voice-anya-${listener.id}-${eventId}`;
        } else if (is_new_todo_note) {
          promptToUse = new_todo_note_prompt;
          seed = `todos-from-user-${listener.id}-${eventId}`;
        } else if (is_message_from_a_manager) {
          promptToUse = message_from_manager_prompt;
          seed = `message-from-manager-${listener.id}-${eventId}`;
        }

        const response = await ask({
          model: attached_image ? "gpt-4o" : "gpt-4o-mini",
          prompt: promptToUse,
          image_url: attached_image ?? undefined,
          seed,
          tools,
        });

        const content = response.choices[0].message.content ?? undefined;

        const ignore = content?.includes("IGNORE");

        if (ignore) {
          console.log("Ignoring event: ", content, payload);
          return;
        }

        // Send a message to the user indicating the event was triggered
        if (notify) {
          await contextMessage.send({
            content,
            flags: is_voice && !is_new_todo_note ? [4096] : undefined,
          });
        } else {
          console.log("Silenced Notification: ", content);
        }

        // Handle auto-stop options
        if (options.autoStopAfterSingleEvent) {
          await removeListener(listener.id, eventId);
        }

        return content;
        // Expiry is handled via periodic cleanup
      } else {
        console.error(
          `❌ Listener "${listener.id}" has neither 'instruction' nor 'template' defined.`
        );
      }
    } catch (error) {
      console.error(`Error sending message to user ${userId}:`, error);
    }
  };

  // Assign the callback to the listener for future reference
  listener.callback = callback;

  // Register the callback with eventManager
  eventManager.on(eventId, callback);
}

export const MarkSetupAsDoneParams = z.object({
  eventId: z.string().min(1, "eventId is required"),
});

export type MarkSetupAsDoneParams = z.infer<typeof MarkSetupAsDoneParams>;

/**
 * Marks the setup of an event as done by setting 'setup_done' to true.
 * @param params - Parameters containing the eventId.
 * @param contextMessage - The message context to identify the user.
 * @returns A JSON object confirming the update or an error.
 */
export async function mark_setup_as_done(
  params: MarkSetupAsDoneParams,
  contextMessage: Message
): Promise<any> {
  // Validate parameters using zod
  const parsed = MarkSetupAsDoneParams.safeParse(params);
  if (!parsed.success) {
    return { error: parsed.error.errors };
  }

  const { eventId } = parsed.data;

  // Get the userId from contextMessage
  const userId: string = contextMessage.author.id;

  // Check if the event exists and is owned by the user
  const event = eventsMap.get(eventId);
  if (!event) {
    return { error: `❌ Event with ID "${eventId}" does not exist.` };
  }

  if (event.userId !== userId) {
    return { error: `❌ You do not have permission to update this event.` };
  }

  // Update the setup_done field
  event.setup_done = true;
  eventsMap.set(eventId, event);
  await saveEventsToFile();

  return {
    eventId,
    setup_done: event.setup_done,
    message: "✅ Event setup marked as done successfully.",
  };
}

/**
 * Simple template renderer that replaces {{key}} with corresponding values from payload.
 * @param template - The string template containing placeholders like {{key}}.
 * @param payload - The payload containing key-value pairs.
 * @returns The formatted string with placeholders replaced by payload values.
 */
function renderTemplate(
  template: string,
  payload: Record<string, string | number>
): string {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (_, key) => {
    return (payload[key.trim()] || `{{${key.trim()}}}`) as string;
  });
}

// Function to fully remove a listener by its ID and eventId
async function removeListener(listenerId: string, eventId: string) {
  const listener = listenersMap.get(listenerId);
  if (!listener) return;

  // Unregister the callback from eventManager
  if (listener.callback) {
    eventManager.off(eventId, listener.callback);
  }

  // Remove from storage
  listenersMap.delete(listenerId);
  await saveListenersToFile();

  console.log(
    `🔕 Listener "${listener.id}" for event "${listener.eventId}" by user "${listener.userId}" has been removed.`
  );
}

// Initialize events and listeners by loading from the files
loadEventsFromFile();
loadListenersFromFile();

// Periodic cleanup for expired listeners
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

setInterval(async () => {
  const now = Date.now();
  const expiredListeners: string[] = [];

  listenersMap.forEach((listener, id) => {
    if (listener.expires_in) {
      const createdAt = new Date(listener.created_at).getTime();
      const expiresInMs = listener.expires_in * 1000;
      if (now > createdAt + expiresInMs) {
        expiredListeners.push(id);
      }
    }
  });

  for (const id of expiredListeners) {
    const listener = listenersMap.get(id);
    if (listener) {
      console.log(
        `🔕 Listener "${listener.id}" for event "${listener.eventId}" by user "${listener.userId}" has expired and will be removed.`
      );
      await removeListener(id, listener.eventId);
    }
  }

  if (expiredListeners.length > 0) {
    await saveListenersToFile();
  }
}, CLEANUP_INTERVAL_MS);

/**
 * Creates an event.
 * @param params - Parameters for creating the event.
 * @param contextMessage - The message context from which the event is created.
 * @returns A JSON object containing the event details and a success message, or an error.
 */
export async function create_event(
  params: CreateEventParams,
  contextMessage: Message
): Promise<any> {
  const parsed = CreateEventParams.safeParse(params);
  if (!parsed.success) {
    return { error: parsed.error.errors };
  }

  let { eventId, description } = parsed.data;

  // Get the userId from contextMessage
  const userId: string = contextMessage.author.id;

  if (eventsMap.has(eventId)) {
    return { error: `❌ Event with ID "${eventId}" already exists.` };
  }

  const event: Event = {
    eventId,
    description,
    userId, // Assign userId to the event
    setup_done: false, // Initialize setup_done to false
  };

  eventsMap.set(eventId, event);
  await saveEventsToFile();

  return {
    eventId,
    description,
    userId,
    setup_done: event.setup_done, // Include setup_done in the response
    message: "✅ Event created successfully.",
  };
}

// 1. Define schema for getting events
export const GetEventsParams = z.object({});

export type GetEventsParams = z.infer<typeof GetEventsParams>;

// 2. Implement the get_events function
export async function get_events(
  params: GetEventsParams,
  contextMessage: Message
): Promise<
  | {
      events: Event[];
    }
  | { error: string }
> {
  // Get the userId from contextMessage
  const userId: string = contextMessage.author.id;

  // Get all events created by this user
  const userEvents = Array.from(eventsMap.values()).filter(
    (event) => event.userId === userId
  );

  return {
    events: userEvents,
  };
}

/**
 * Creates an event listener.
 * @param params - Parameters for creating the listener.
 * @param contextMessage - The message context from which the listener is created.
 * @returns A JSON object containing the listener details and a success message, or an error.
 */
export async function create_event_listener(
  params: CreateEventListenerParams,
  contextMessage: Message
): Promise<any> {
  // Validate parameters using zod
  const parsed = CreateEventListenerParams.safeParse(params);
  if (!parsed.success) {
    return { error: parsed.error.errors };
  }

  let {
    eventId,
    description,
    instruction,
    template,
    tool_names,
    autoStopAfterSingleEvent = true,
    autoStopAfterDelay,
    notify,
  } = parsed.data;

  // Check if the event exists
  if (!eventsMap.has(eventId)) {
    return { error: `❌ Event with ID "${eventId}" does not exist.` };
  }

  // Get the userId from contextMessage
  const userId: string = contextMessage.author.id;

  // Create a unique listener ID
  const listenerId = uuidv4();

  // Calculate expires_in if autoStopAfterDelay is set
  const expires_in = autoStopAfterDelay ? autoStopAfterDelay : undefined;

  // Create the listener object
  const listener: EventListener = {
    id: listenerId,
    eventId,
    userId,
    description,
    instruction,
    template, // Assign template if provided
    options: {
      autoStopAfterSingleEvent,
      autoStopAfterDelay,
    },
    tool_names,
    created_at: new Date().toISOString(),
    expires_in,
    notify,
  };

  // Store the listener in the in-memory storage
  listenersMap.set(listener.id, listener);

  // Register the listener with eventManager
  registerListener(listener);

  // Save the updated listeners to the JSON file
  await saveListenersToFile();

  // Return the listener details as confirmation
  return {
    listenerId,
    eventId,
    userId,
    description,
    instruction,
    template, // Include template in the response if provided
    created_at: listener.created_at,
    expires_in: listener.expires_in,
    message: "✅ Event listener created successfully.",
  };
}

/**
 * Retrieves all event listeners created by the user.
 * @param params - Parameters for getting event listeners (none required).
 * @param contextMessage - The message context to identify the user.
 * @returns A JSON array of the user's event listeners or an error.
 */
export async function get_event_listeners(
  params: {},
  contextMessage: Message
): Promise<any> {
  // Get the userId from contextMessage
  const userId: string = contextMessage.author.id;

  // Get all listeners created by this user
  const userListeners = Array.from(listenersMap.values()).filter(
    (listener) => listener.userId === userId
  );

  return {
    listeners: userListeners,
  };
}

/**
 * Updates the description of an event.
 * @param params - Parameters containing the eventId and new description.
 * @param contextMessage - The message context to identify the user.
 * @returns A JSON object confirming the update or an error.
 */
export async function update_event_description(
  params: UpdateEventDescriptionParams,
  contextMessage: Message
): Promise<any> {
  // Validate parameters using zod
  const parsed = UpdateEventDescriptionParams.safeParse(params);
  if (!parsed.success) {
    return { error: parsed.error.errors };
  }

  const { eventId, description } = parsed.data;

  // Get the userId from contextMessage
  const userId: string = contextMessage.author.id;

  // Check if the event exists and is owned by the user
  const event = eventsMap.get(eventId);
  if (!event) {
    return { error: `❌ Event with ID "${eventId}" does not exist.` };
  }

  if (event.userId !== userId) {
    return { error: `❌ You do not have permission to update this event.` };
  }

  // Update the event description
  event.description = description;
  eventsMap.set(eventId, event);
  await saveEventsToFile();

  return {
    eventId,
    description,
    message: "✅ Event description updated successfully.",
  };
}

/**
 * Updates the details of an event listener.
 * @param params - Parameters containing the listenerId and fields to update.
 * @param contextMessage - The message context to identify the user.
 * @returns A JSON object confirming the update or an error.
 */
export async function update_event_listener(
  params: UpdateEventListenerParams,
  contextMessage: Message
): Promise<any> {
  // Validate parameters using zod
  const parsed = UpdateEventListenerParams.safeParse(params);
  if (!parsed.success) {
    return { error: parsed.error.errors };
  }

  const {
    listenerId,
    eventId,
    description,
    instruction,
    template,
    tool_names,
    autoStopAfterSingleEvent,
    autoStopAfterDelay,
  } = parsed.data;

  // Get the userId from contextMessage
  const userId: string = contextMessage.author.id;

  // Find the listener
  const listener = listenersMap.get(listenerId);
  if (!listener) {
    return { error: `❌ Listener with ID "${listenerId}" not found.` };
  }

  // Ensure the listener belongs to the user
  if (listener.userId !== userId) {
    return { error: `❌ You do not have permission to update this listener.` };
  }

  // If eventId is being updated, ensure the new event exists
  if (eventId !== listener.eventId) {
    if (!eventsMap.has(eventId)) {
      return { error: `❌ Event with ID "${eventId}" does not exist.` };
    }
    // Unregister the old event
    if (listener.callback) {
      eventManager.off(listener.eventId, listener.callback);
    }
    listener.eventId = eventId;
    // Register the new event
    registerListener(listener);
  }

  // Update other fields
  listener.description = description;
  listener.instruction = instruction;
  listener.template = template; // Update template if provided
  listener.tool_names = tool_names;
  if (autoStopAfterSingleEvent !== undefined) {
    listener.options.autoStopAfterSingleEvent = autoStopAfterSingleEvent;
  }
  if (autoStopAfterDelay !== undefined) {
    listener.options.autoStopAfterDelay = autoStopAfterDelay;
    listener.expires_in = autoStopAfterDelay;
  } else if (autoStopAfterDelay === undefined && template) {
    // If updating and template is provided without autoStopAfterDelay, remove expires_in
    listener.expires_in = undefined;
  }

  listenersMap.set(listenerId, listener);
  await saveListenersToFile();

  return {
    listenerId,
    eventId,
    userId,
    description,
    instruction,
    template,
    created_at: listener.created_at,
    expires_in: listener.expires_in,
    message: "✅ Event listener updated successfully.",
  };
}

// Export the tools as RunnableToolFunctionWithParse array
export const event_tools: (
  context_message: Message,
  valid_tool_names: string[]
) => RunnableToolFunctionWithParse<any>[] = (context_message) => [
  zodFunction({
    name: "create_event",
    function: (args) => create_event(args, context_message),
    schema: CreateEventParams,
    description: `Creates a new event.`,
  }),
  zodFunction({
    name: "create_event_listener",
    function: (args) => create_event_listener(args, context_message),
    schema: CreateEventListenerParams,
    description: `Create an event listener to respond to specific events and notify the user.
Before creating a new listener, use 'get_event_listeners' to check for existing ones. 
If a similar listener exists, confirm whether the user wants to proceed with a new one.
You can create either a dynamic listener using 'instruction' and 'tool_names' or a static listener using a 'template'.

Examples:
1. Dynamic Listener:
   - User: "Turn on the lights when I get home"
     - Description: "Turns on lights when the user arrives home"
     - Instruction: "Turn on the lights and welcome the user"
     - Required Tools: ["home_assistant_manager"]

Notes:
- When using 'template', make sure you confirm from that user that the payload variables are correct and would actually be there when the event is triggered.
- When using 'template', ensure to use double curly braces to reference payload variables, e.g., {{variableName}}.
`,
  }),
  zodFunction({
    name: "update_event_description",
    function: (args) => update_event_description(args, context_message),
    schema: UpdateEventDescriptionParams,
    description: `Updates the description of an existing event.`,
  }),
  zodFunction({
    name: "update_event_listener",
    function: (args) => update_event_listener(args, context_message),
    schema: UpdateEventListenerParams,
    description: `Updates the details of an existing event listener.
This needs all details of the old listener to update it.
This basically replaces the old listener with the new one created by the params that are passed.

You can update either the 'instruction' for dynamic listeners or the 'template' for static listeners.

When updating with a 'template', ensure to use double curly braces to reference payload variables, e.g., {{variableName}}.
`,
  }),
  zodFunction({
    name: "remove_event_listener",
    function: (args) => remove_event_listener_tool(args),
    schema: RemoveEventListenerParamsSchema,
    description: `Removes an event listener by specifying the listener ID.`,
  }),
  zodFunction({
    name: "mark_setup_as_done",
    function: (args) => mark_setup_as_done(args, context_message),
    schema: MarkSetupAsDoneParams,
    description: `Marks the setup of an event as done by setting 'setup_done' to true.`,
  }),
];

// make event manager tool for the above tools
export const EventManagerSchema = z.object({
  request: z
    .string()
    .describe(
      "What the user wants to do relatingto external events listeners or automation"
    ),
  tool_names: z
    .array(z.string())
    .optional()
    .describe("Names of the tools required to execute the instruction."),
});

type EventManagerSchema = z.infer<typeof EventManagerSchema>;

export async function event_manager(
  { request, tool_names }: EventManagerSchema,
  context_message: Message
): Promise<any> {
  const tools = event_tools(context_message, tool_names ?? []).concat(
    memory_manager_init(context_message, "events_manager")
  );

  const userConfigData = userConfigs.find((config) =>
    config.identities.find((id) => id.id === context_message.author.id)
  );

  try {
    const all_actions = await get_actions({}, context_message);

    const all_events = await get_events({}, context_message);

    const all_event_listeners = await get_event_listeners({}, context_message);

    const response = await ask({
      model: "gpt-4o-mini",
      prompt: `You are an Events Manager.

Each event can have multiple listeners, and each listener can have multiple actions.

A listener is a function that reacts to an event, performs an action, and automatically generates a notification string to send to the user. (The user will be automatically notified with this string.)

The webhook URL is \`https://events.raj.how/events/{event_id}\`, which triggers all listeners for that event ID. When you create a new event or the user requests the URL for a specific event, share this URL with the user so they can set up the webhook. Once the webhook is set up, you don't need to send the webhook URL to the user again.

----

${memory_manager_guide("events_manager", context_message.author.id)}

----

**Examples & Use Cases:**

1. **Action on Location Event:**
   - User can create an event called "reached_home" and set up a listener for this event to turn on the lights when they reach home.
   - Or add a listener to send a message to the user when they reach home.
   - Or any action when the event "reached_home" is triggered.

2. **Action on WhatsApp Event:**
   - **User:** "When I get a message on WhatsApp from Raj, tell him that I'm driving."
   - **Event:** "got_whatsapp_message"
   - **Listener:** "When Raj is the sender, reply with 'I'm driving.' using the \`communication_manager\` tool and notify the user that you replied with 'I'm driving.'"
   - **Tool Names:** \`["communication_manager"]\`

**Guidelines:**

- When the user says something like: "Turn on the lights when I reach home":
  1. **Check Existing Events:**
     - Retrieve all events to see if any match the user's request.
     - If a matching event exists and \`setup_done\` is \`true\`, use this event ID to create a listener.
     - If \`setup_done\` is \`false\`, share the webhook URL with the user for setup and wait until \`setup_done\` is \`true\` before creating listeners.
  2. **Create New Event:**
     - If no matching event exists, create a new event.
     - Set \`setup_done\` to \`false\` and share the webhook URL with the user for setup.
     - Do not create listeners until the user confirms the webhook setup and \`setup_done\` is marked as \`true\`.

**Important Notes:**

- **Do not create listeners for events where \`setup_done\` is \`false\`.**

- **Webhook Setup:**
  - If \`setup_done\` is \`false\` for an event, share the webhook URL with the user for setup.
  - Once the user confirms the webhook is set up, mark \`setup_done\` as \`true\`.
  - Do not share the webhook URL again if \`setup_done\` is \`true\`; proceed with setting up listeners.

- **Event Management:**
  - You can create, update, and remove events and event listeners.
  - Try to use existing events whenever possible. Create new ones only when absolutely necessary.

- **Action Similarity:**
  - Review the actions provided by the \`action_manager\`. If any action is too similar to an event listener, point this out to the user.

- **Fulfill User Requests:**
  - Your primary goal is to fulfill the user's requests based on the above guidelines.

**Additional Information:**

- **Current Date:** ${new Date().toISOString()}

- **Current User Details:** ${JSON.stringify(userConfigData)}

- **Actions Set Up by \`action_manager\`:**
  ${JSON.stringify(all_actions)}

- **Already Existing Valid Available Events:**
  ${JSON.stringify(all_events)}

- **Valid Event Listeners:**
  ${JSON.stringify(all_event_listeners)}

- **Tool Names List for Creating a Listener:**
  ${JSON.stringify(tool_names)}
          `,
      tools,
      seed: context_message.channelId,
      message: request,
    });

    console.log(response.choices[0].message.content);

    return {
      response: response.choices[0].message.content,
    };
  } catch (error) {
    console.error("Error in event_manager:", error);
    return {
      error,
    };
  }
}

export function return_current_events() {
  return Array.from(eventsMap.values());
}
export function return_current_listeners() {
  return Array.from(listenersMap.values());
}
