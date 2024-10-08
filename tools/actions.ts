// actions.ts
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
import { ask } from "./ask";
import Fuse from "fuse.js";
import cron from "node-cron";
import { pathInDataDir, userConfigs } from "../config";
import { get_event_listeners } from "./events";
import { memory_manager_guide, memory_manager_init } from "./memory-manager";

// Paths to the JSON files
const ACTIONS_FILE_PATH = pathInDataDir("actions.json");

// Define schema for creating an action
export const CreateActionParams = z.object({
  actionId: z
    .string()
    .describe(
      "The unique identifier for the action. Make this relevant to the action."
    ),
  description: z
    .string()
    .min(1, "description is required")
    .describe("Short description of the action."),
  schedule: z
    .object({
      type: z.enum(["delay", "cron"]).describe("Type of scheduling."),
      time: z.union([
        z.number().positive().int().describe("Delay in seconds."),
        z.string().describe("Cron expression."),
      ]),
    })
    .describe("Scheduling details for the action."),
  instruction: z
    .string()
    .min(1, "instruction is required")
    .describe(
      "Detailed instructions on what to do when the action is executed."
    ),
  tool_names: z
    .array(z.string())
    .optional()
    .describe(
      `Names of the tools required to execute the instruction of an action.
      Each of these should look something like "home_assistant_manager" or "calculator" and NOT "function:home_assistant_manager" or "function.calculator".`
    ),
  notify: z
    .boolean()
    .describe(
      "Wheater to notify the user when the action is executed or not with the action's output."
    ),
});

// Type for creating an action
export type CreateActionParams = z.infer<typeof CreateActionParams>;

// Define schema for searching actions
export const SearchActionsParams = z.object({
  userId: z.string().optional(),
  actionId: z.string().optional(),
});

// Type for searching actions
export type SearchActionsParams = z.infer<typeof SearchActionsParams>;

// Define schema for removing an action
const RemoveActionParamsSchema = z.object({
  actionId: z.string().min(1, "actionId is required"),
});

// Type for removing an action
type RemoveActionParams = z.infer<typeof RemoveActionParamsSchema>;

// Define schema for updating an action
export const UpdateActionParams = z
  .object({
    actionId: z.string().min(1, "actionId is required"),
    description: z.string().min(1, "description is required"),
    schedule: z
      .object({
        type: z.enum(["delay", "cron"]).describe("Type of scheduling."),
        time: z.union([
          z.number().positive().int().describe("Delay in seconds."),
          z.string().describe("Cron expression."),
        ]),
      })
      .describe("Scheduling details for the action."),
    instruction: z
      .string()
      .min(1, "instruction is required")
      .describe(
        "Detailed instructions on what to do when the action is executed."
      )
      .optional(),
    template: z
      .string()
      .min(1, "template is required")
      .describe(
        "A string template to format the action payload. Use double curly braces to reference variables, e.g., {{variableName}}."
      )
      .optional(),
    tool_names: z
      .array(z.string())
      .optional()
      .describe(
        "Names of the tools required to execute the instruction when the action is executed."
      ),
    notify: z
      .boolean()
      .optional()
      .describe(
        "Whether to notify the user when the action is executed or not with the action's output."
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

// Type for updating an action
export type UpdateActionParams = z.infer<typeof UpdateActionParams>;

// Define the structure of an Action
interface Action {
  actionId: string;
  description: string;
  userId: string;
  schedule: {
    type: "delay" | "cron";
    time: number | string;
  };
  instruction?: string;
  template?: string;
  tool_names?: string[];
  notify: boolean;
  created_at: string; // ISO string for serialization
}

// In-memory storage for actions
const actionsMap: Map<string, Action> = new Map();

// Helper function to load actions from the JSON file
async function loadActionsFromFile() {
  try {
    const data = await fs.readFile(ACTIONS_FILE_PATH, "utf-8");
    const parsed = JSON.parse(data) as Action[];
    parsed.forEach((action) => {
      actionsMap.set(action.actionId, action);
      scheduleAction(action);
    });
    console.log(
      `✅ Loaded ${actionsMap.size} actions from ${ACTIONS_FILE_PATH}`
    );
  } catch (error: any) {
    if (error.code === "ENOENT") {
      // File does not exist, create an empty file
      await saveActionsToFile();
      console.log(`📄 Created new actions file at ${ACTIONS_FILE_PATH}`);
    } else {
      console.error(`❌ Failed to load actions from file: ${error.message}`);
    }
  }
}

// Helper function to save actions to the JSON file
async function saveActionsToFile() {
  const data = JSON.stringify(Array.from(actionsMap.values()), null, 2);
  await fs.writeFile(ACTIONS_FILE_PATH, data, "utf-8");
}

// Function to schedule an action based on its schedule
function scheduleAction(action: Action) {
  if (
    action.schedule.type === "delay" &&
    typeof action.schedule.time === "number"
  ) {
    const createdAt = new Date(action.created_at).getTime();
    const currentTime = Date.now();
    const delayInMs = action.schedule.time * 1000;
    const elapsedTime = currentTime - createdAt;
    const remainingTime = delayInMs - elapsedTime;

    if (remainingTime > 0) {
      setTimeout(async () => {
        await executeAction(action);
        // After execution, remove the action as it's a one-time delay
        actionsMap.delete(action.actionId);
        await saveActionsToFile();
        console.log(`🗑️ Removed action "${action.actionId}" after execution.`);
      }, remainingTime);
      console.log(
        `⏰ Scheduled action "${action.actionId}" to run in ${Math.round(
          remainingTime / 1000
        )} seconds.`
      );
    } else {
      // If the remaining time is less than or equal to zero, execute immediately
      executeAction(action).then(async () => {
        actionsMap.delete(action.actionId);
        await saveActionsToFile();
        console.log(
          `🗑️ Removed action "${action.actionId}" after immediate execution.`
        );
      });
      console.log(
        `⚡ Executed action "${action.actionId}" immediately as the delay has already passed.`
      );
    }
  } else if (
    action.schedule.type === "cron" &&
    typeof action.schedule.time === "string"
  ) {
    // Schedule the action using the cron expression
    cron.schedule(action.schedule.time, () => {
      executeAction(action);
    });

    console.log(
      `🕒 Scheduled action "${action.actionId}" with cron expression "${action.schedule.time}".`
    );
  } else {
    console.error(`❌ Invalid schedule for action "${action.actionId}".`);
  }
}

// Function to execute an action
async function executeAction(action: Action) {
  try {
    // Recreate the Message instance using discordAdapter
    const contextMessage: Message = await discordAdapter.createMessageInterface(
      action.userId
    );
    if (!contextMessage) {
      console.error(
        `❌ Unable to create Message interface for user "${action.userId}".`
      );
      return;
    }

    if (action.template) {
      // Handle static action with template
      const payload = {}; // Define how to obtain payload if needed
      const formattedMessage = renderTemplate(action.template, payload);
      await contextMessage.send({ content: formattedMessage });
    } else if (action.instruction && action.tool_names) {
      // Handle dynamic action with instruction and tools
      let tools = getTools(
        contextMessage.author.username,
        contextMessage
      ).filter(
        (tool) =>
          tool.function.name && action.tool_names?.includes(tool.function.name)
      ) as RunnableToolFunctionWithParse<any>[] | undefined;

      tools = tools?.length ? tools : undefined;

      const response = await ask({
        model: "gpt-4o",
        prompt: `You are an Action Executor.
      
      You are called to execute an action based on the provided instruction.
      
      **Guidelines:**
      
      1. **Notifying the Current User:**
         - Any message you reply with will automatically be sent to the user as a notification.
      
      **Example:**
      
      - **Instruction:** "Tell Pooja happy birthday"
      - **Tool Names:** ["communication_manager"]
      - **Notify:** true
      - **Steps:**
        1. Ask \`communication_manager\` to wish Pooja a happy birthday to send a message to the recipient mentioned by the user.
        2. Reply to the current user with "I wished Pooja a happy birthday." to notify the user.
      
      **Action Details:**
      
      - **Action ID:** ${action.actionId}
      - **Description:** ${action.description}
      - **Instruction:** ${action.instruction}
      
      Use the required tools/managers as needed.
      `,
        tools: tools?.length ? tools : undefined,
      });

      const content = response.choices[0].message.content ?? undefined;

      // Send a message to the user indicating the action was executed
      await contextMessage.send({ content });
    } else {
      console.error(
        `❌ Action "${action.actionId}" has neither 'instruction' nor 'template' defined properly.`
      );
    }
  } catch (error) {
    console.error(`Error executing action "${action.actionId}":`, error);
  }
}

/**
 * Simple template renderer that replaces {{key}} with corresponding values from payload.
 * @param template - The string template containing placeholders like {{key}}.
 * @param payload - The payload containing key-value pairs.
 * @returns The formatted string with placeholders replaced by payload values.
 */
function renderTemplate(
  template: string,
  payload: Record<string, string>
): string {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (_, key) => {
    return payload[key.trim()] || `{{${key.trim()}}}`;
  });
}

/**
 * Creates an action.
 * @param params - Parameters for creating the action.
 * @param contextMessage - The message context from which the action is created.
 * @returns A JSON object containing the action details and a success message, or an error.
 */
export async function create_action(
  params: CreateActionParams,
  contextMessage: Message
): Promise<any> {
  const parsed = CreateActionParams.safeParse(params);
  if (!parsed.success) {
    return { error: parsed.error.errors };
  }

  let { actionId, description, schedule, instruction, tool_names } =
    parsed.data;

  // Get the userId from contextMessage
  const userId: string = contextMessage.author.id;

  if (actionsMap.has(actionId)) {
    return { error: `❌ Action with ID "${actionId}" already exists.` };
  }

  const send_message_tools = tool_names?.filter(
    (t) => t.includes("send_message") && !t.startsWith("confirm_")
  );
  if (send_message_tools?.length) {
    return {
      confirmation: `You are using tools that sends a message to the user explicitly.
      Tool names that triggered this confirmation: [${send_message_tools.join(
        ", "
      )}]
      Use these only to send a message to a different user or channel. Not sending this tool would by default send the message to the user anyway.
      To use this tool anyway like to send a message to a different user or channel, please re run create command and prefix the tool name with 'confirm_'`,
    };
  }

  tool_names = tool_names?.map((t) =>
    t.startsWith("confirm_") ? t.replace("confirm_", "") : t
  );

  const action: Action = {
    actionId,
    description,
    userId,
    schedule,
    instruction,
    tool_names,
    notify: params.notify ?? true,
    created_at: new Date().toISOString(),
  };

  actionsMap.set(actionId, action);
  await saveActionsToFile();

  // Schedule the action
  scheduleAction(action);

  return {
    actionId,
    description,
    userId,
    schedule,
    instruction,
    tool_names,
    created_at: action.created_at,
    message: "✅ Action created and scheduled successfully.",
  };
}

// 1. Define schema for getting actions
export const GetActionsParams = z.object({});

export type GetActionsParams = z.infer<typeof GetActionsParams>;

// 2. Implement the get_actions function
export async function get_actions(
  params: GetActionsParams,
  contextMessage: Message
): Promise<any> {
  // Get the userId from contextMessage
  const userId: string = contextMessage.author.id;

  // Get all actions created by this user
  const userActions = Array.from(actionsMap.values()).filter(
    (action) => action.userId === userId
  );

  return {
    actions: userActions,
  };
}

/**
 * Removes an action by its actionId by fully deleting it.
 * @param params - Parameters containing the actionId.
 * @returns A JSON object confirming removal or an error.
 */
export async function remove_action(params: RemoveActionParams): Promise<any> {
  // Validate parameters using zod
  const parsed = RemoveActionParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { error: parsed.error.errors };
  }

  const { actionId } = parsed.data;

  const action = actionsMap.get(actionId);

  if (!action) {
    return {
      error: `❌ Action with ID "${actionId}" not found.`,
    };
  }

  // Remove the action from the map
  actionsMap.delete(actionId);
  await saveActionsToFile();

  // Note: In a real implementation, you'd also need to cancel the scheduled task.
  // This can be managed by keeping track of timers or using a scheduler that supports cancellation.

  return {
    message: `✅ Action with ID "${actionId}" removed successfully.`,
  };
}

/**
 * Updates the details of an action.
 * @param params - Parameters containing the actionId and fields to update.
 * @param contextMessage - The message context to identify the user.
 * @returns A JSON object confirming the update or an error.
 */
export async function update_action(
  params: UpdateActionParams,
  contextMessage: Message
): Promise<any> {
  // Validate parameters using zod
  const parsed = UpdateActionParams.safeParse(params);
  if (!parsed.success) {
    return { error: parsed.error.errors };
  }

  const {
    actionId,
    description,
    schedule,
    instruction,
    template,
    tool_names,
    notify,
  } = parsed.data;

  // Get the userId from contextMessage
  const userId: string = contextMessage.author.id;

  // Find the action
  const action = actionsMap.get(actionId);
  if (!action) {
    return { error: `❌ Action with ID "${actionId}" not found.` };
  }

  // Ensure the action belongs to the user
  if (action.userId !== userId) {
    return { error: `❌ You do not have permission to update this action.` };
  }

  // Update fields
  action.description = description;
  action.schedule = schedule;
  action.instruction = instruction;
  action.template = template;
  action.notify = notify ?? action.notify;
  action.tool_names = tool_names;

  actionsMap.set(actionId, action);
  await saveActionsToFile();

  // Reschedule the action
  scheduleAction(action);

  return {
    actionId,
    description,
    userId,
    schedule,
    instruction,
    template,
    tool_names,
    created_at: action.created_at,
    message: "✅ Action updated and rescheduled successfully.",
  };
}

const action_tools: (
  context_message: Message
) => RunnableToolFunctionWithParse<any>[] = (context_message) => [
  zodFunction({
    name: "create_action",
    function: (args) => create_action(args, context_message),
    schema: CreateActionParams,
    description: `Creates a new action.

**Example:**
- **User:** "Send a summary email in 10 minutes"
  - **Action ID:** "send_summary_email"
  - **Description:** "Sends a summary email after a delay."
  - **Schedule:** { type: "delay", time: 600 }
  - **Instruction:** "Compose and send a summary email to the user."
  - **Required Tools:** ["email_service"]

**Notes:**
- Supported scheduling types: 'delay' (in seconds), 'cron' (cron expressions).
`,
  }),
  //   zodFunction({
  //     name: "get_actions",
  //     function: (args) => get_actions(args, context_message),
  //     schema: GetActionsParams,
  //     description: `Retrieves all actions created by the user.

  // Use this to obtain action IDs for updating or removing actions."
  // `,
  //   }),
  zodFunction({
    name: "update_action",
    function: (args) => update_action(args, context_message),
    schema: UpdateActionParams,
    description: `Updates an existing action's details.

Provide all details of the action to replace it with the new parameters.
`,
  }),
  zodFunction({
    name: "remove_action",
    function: (args) => remove_action(args),
    schema: RemoveActionParamsSchema,
    description: `Removes an action using the action ID.`,
  }),
];

export const ActionManagerParamsSchema = z.object({
  request: z
    .string()
    .describe(
      "What the user wants you to do in the action. Please provide the time / schedule as well."
    ),
  tool_names: z
    .array(z.string())
    .optional()
    .describe("Names of the tools required to execute the instruction."),
  suggested_time_to_run_action: z.string().optional(),
});

export type ActionManagerParams = z.infer<typeof ActionManagerParamsSchema>;

// -------------------- Fuzzy Search for Actions -------------------- //

export const FuzzySearchActionsParams = z.object({
  query: z.string(),
});
export type FuzzySearchActionsParams = z.infer<typeof FuzzySearchActionsParams>;

export async function fuzzySearchActions({
  query,
}: FuzzySearchActionsParams): Promise<{ matches: any[] }> {
  try {
    // Fetch all actions (Assuming get_actions is already defined and returns actions)
    const { actions } = await get_actions({}, {
      author: { id: "system" },
    } as any); // Replace with actual contextMessage if available

    if (!actions) {
      return { matches: [] };
    }

    const fuseOptions = {
      keys: ["description", "actionId"],
      threshold: 0.3, // Adjust the threshold as needed
    };

    const fuse = new Fuse(actions, fuseOptions);
    const results = fuse.search(query);

    // Get top 2 results
    const topMatches = results.slice(0, 2).map((result) => result.item);

    return { matches: topMatches };
  } catch (error) {
    console.error("Error performing fuzzy search on actions:", error);
    return { matches: [] };
  }
}

// -------------------- Manager Function -------------------- //

/**
 * Manages user requests related to actions by orchestrating CRUD operations.
 * It can handle creating, updating, retrieving, and removing actions based on user input.
 *
 * @param params - Parameters containing the user's request, the action name, and an optional delay.
 * @returns A JSON object containing the response from executing the action or an error.
 */
export async function actionManager(
  { request, tool_names, suggested_time_to_run_action }: ActionManagerParams,
  context_message: Message
): Promise<any> {
  // Validate parameters using Zod
  const parsed = ActionManagerParamsSchema.safeParse({
    request,
  });
  if (!parsed.success) {
    return { error: parsed.error.errors };
  }

  const { request: userRequest } = parsed.data;

  const all_actions = await get_actions({}, context_message);

  const userConfigData = userConfigs.find((config) =>
    config.identities.find((id) => id.id === context_message.author.id)
  );

  // Construct the prompt for the ask function
  const prompt = `You are an Action Manager.

Your role is to manage scheduled actions.

**Current Time:** ${new Date().toLocaleString()}

----

${memory_manager_guide("actions_manager")}

----

**Actions You Have Set Up for This User:**
${JSON.stringify(all_actions.actions)}

**Current User Details:**
${JSON.stringify(userConfigData)}

**Tools Suggested by user for Action:**
${JSON.stringify(tool_names)}

---

Use the data provided above to fulfill the user's request.
`;

  const tools = action_tools(context_message).concat(
    memory_manager_init(context_message, "actions_manager")
  );

  // console.log("Action Manager Tools:", tools);

  // Execute the action using the ask function with the appropriate tools
  try {
    const response = await ask({
      prompt,
      message: `${userRequest}
      
      Suggested time: ${suggested_time_to_run_action}
      `,
      seed: `action_manager_${context_message.channelId}`,
      tools,
    });

    return {
      response: response.choices[0].message.content,
    };
  } catch (error) {
    console.error("Error executing action via manager:", error);
    return {
      error: "❌ An error occurred while executing your request.",
    };
  }
}

// Initialize by loading actions from file when the module is loaded
loadActionsFromFile();
