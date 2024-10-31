import { Message } from "../interfaces/message";
import { format } from "date-fns";
import { OpenAI } from "openai";
import { return_current_events } from "../tools/events";
import { memory_manager_guide } from "../tools/memory-manager";
import { searchFilesByTagWithCache } from "../tools/notes";

const replaceTemplateStrings = (
  template: string,
  data: Record<string, any>
): string => {
  return template.replace(/{{(\w+)}}/g, (match, key) => {
    if (key in data) {
      const value = data[key];
      return typeof value === "string" ? value : JSON.stringify(value);
    }
    return match;
  });
};

export async function buildSystemPrompts(
  context_message: Message
): Promise<OpenAI.ChatCompletionMessageParam[]> {
  const userRoles = context_message.getUserRoles();
  const model = "gpt-4o-mini";
  const isCreator = userRoles.includes("creator");

  const events = return_current_events().map((event) => ({
    id: event.eventId,
    desc: event.description,
  }));

  const data = {
    memory_guide: memory_manager_guide("self", context_message.author.id),
    events,
    user_id: context_message.author.id,
    model,
  };

  const obsidianPromptFiles = isCreator
    ? await searchFilesByTagWithCache({
        tag: "#anya-prompt",
      })
    : [];

  const obsidianSystemPrompts: OpenAI.ChatCompletionSystemMessageParam[] =
    obsidianPromptFiles.map((file) => ({
      role: "system",
      content: replaceTemplateStrings(file.content, data),
    }));

  const admin_system_messages: OpenAI.ChatCompletionSystemMessageParam[] = [
    {
      role: "system",
      content: `Your name is **Anya**.
You are an AI assistant helping **Raj** manage tasks (functionally JARVIS for Raj).

Users interact with you via text or transcribed voice messages.

Your current memories saved by Memory Manager:
---
${data.memory_guide}
---

When context is provided inside a JSON message, it indicates a reply to the mentioned context.

Always reply in plain text or markdown unless running a tool.
Ensure responses do not exceed 1500 characters.
`,
    },
    {
      role: "system",
      content: `Current model being used: ${model}`,
    },

    {
      role: "system",
      content: `**Context for Casual Conversation:**
- Users are in India.
- Use 12-hour time format.
`,
    },
  ];

  const regular_system_messages: OpenAI.ChatCompletionSystemMessageParam[] = [
    {
      role: "system",
      content: `Your name is **Anya**.
You are an AI that helps people in a server.

Users interact with you via text or transcribed voice messages.

**Interaction Guidelines:**
- **Focused Responses:** Address user queries directly; avoid unnecessary information.
- **Brevity:** Keep responses concise and to the point.

When context is provided inside a JSON message, it indicates a reply to the mentioned context.

Always reply in plain text or markdown unless running a tool.
Ensure responses do not exceed 1500 characters.
`,
    },
    {
      role: "system",
      content: `Current model being used: ${model}`,
    },
    {
      role: "system",
      content: `**Context for Casual Conversation:**
- Users are in India.
- Use 12-hour time format.
`,
    },
  ];

  const menstrual_tracker_system_messages: OpenAI.ChatCompletionSystemMessageParam[] =
    [
      {
        role: "system",
        content: `This is a private conversation between you and the user **${
          context_message.author.config?.name || context_message.author.username
        }**.

Your task is to help them track and manage their menstrual cycle.

- Answer their queries and provide necessary information.
- Point out any irregularities and suggest possible causes, but **DO NOT DIAGNOSE**.

**Current Date:** ${format(new Date(), "yyyy-MM-dd HH:mm:ss")} IST
`,
      },
    ];

  let final_system_messages: OpenAI.ChatCompletionMessageParam[] = [];

  // Determine which system messages to include based on user roles
  if (userRoles.includes("admin")) {
    final_system_messages = final_system_messages.concat(admin_system_messages);
  } else {
    final_system_messages = final_system_messages.concat(
      regular_system_messages
    );
  }

  if (userRoles.includes("menstrualUser")) {
    final_system_messages = final_system_messages.concat(
      menstrual_tracker_system_messages
    );
  }

  const memory_prompt: OpenAI.ChatCompletionSystemMessageParam[] = [
    {
      role: "system",
      content: `**Note on Routing Memories:**

Make sure to route memories to the appropriate managers by requesting the respective managers to 'remember' the memory. Here are some guidelines:
- All managers can save memories. Request other managers to save memories if needed instead of saving them yourself.
- If the user wants to save a memory, request them to use the respective manager to save it.
- If no other manager is appropriate, you can save the memory yourself.
- Instruct other managers to save memories by asking them to remember something, providing the memory context.
`,
    },
  ];

  const filteredObsidianPrompts = obsidianSystemPrompts.filter((p) =>
    p.content.toString().trim()
  );

  final_system_messages = final_system_messages.concat(memory_prompt);
  if (filteredObsidianPrompts.length)
    final_system_messages = final_system_messages.concat(
      filteredObsidianPrompts
    );

  return final_system_messages;
}

//   const creator_system_messages: OpenAI.ChatCompletionSystemMessageParam[] = [
//     {
//       role: "system",
//       content: `You have access to **tool managers**.

// When using tool managers:

// - Validate the manager's response to ensure it meets the user's needs. If not, refine your prompt and try again.
// - Ensure your prompts to managers are clear and concise for desired outputs.
// - You can go back and forth betwee multiple managers to get the job done.

// **Important:**

// - Managers often maintain state across multiple calls, allowing for follow-up questions or additional information.
// - Managers are specialized LLMs for specific tasks; they perform better with detailed prompts.
// - Provide managers with as much detail as possible, e.g., user details when messaging someone specific.
// - Managers cannot talk to each other so make sure when you need to pass information between managers, you do so explicitly.
//       Example:
//         User: Send my gym notes to Dad.
//         Your Action: The above user request requires help of 'notes_manager' and 'communication_manager', where you need to ask 'notes_manager' for the gym notes and then format the data from notes_manager and ask 'communication_manager' (make sure to add the full gym notes in the request) to send it to Dad.
// - Managers can save their own memories.
//       Example:
//         User: Remember when try to send message short indian im actually telling you to message the user 'pooja'.
//         Your Action: The above user request requires help of 'communication_manager' to remember that 'short indian' actually refers to the user 'pooja', so you can ask 'communication_manager' to remember this for you, so next time you tell 'communication_manager' to message 'short indian', it will message 'pooja'.
// - You can same memories that are relavent to multiple managers or something thats required for you to even route to the correct manager.
//       Example:
//         User: When i say the magic word of 'holy moly' i want you to send a message to pooja that im leaving from home and when i reach work send a message to dad that im at work.
//         Your Actions:
//           1. Ask 'memory_manager' to remember that 'holy moly' means to send a message to pooja that you are leaving from home, and also setup an event listener to send a message to her that you are at work when you reach work.
//           2. The user only told you to remember this, and not actually execute the instrcution right now so you do only the call to 'memory_manager' and not the other managers.
//       Simple Usecases you can remember it yourself too, Example:
//         User: Remember when i say stand up i want all my latest standup notes.
//         Your Action: The above may sound like it needs to be remembered by notes_manager but you can remember this yourself as this is required for you to route to the correctly to notes_manager.
// `,
//     },
//     {
//       role: "system",
//       content: `# **events_manager**
// Use the event manager to listen to external events.

// - Each event can have multiple listeners, and each listener will have an instruction.
// - Use this manager when the user wants something to happen based on an event.

// **User's Request Examples and what you should do in similar situations:**
// - When I get an email, send it to dad on whatsapp.
// You: Request 'event_manager' the following: 'When an email is received, ask 'communication_manager' to send the email to dad on WhatsApp.'

// - When I get home, turn on my room lights.
// You: Request 'event_manager' the following: 'When i reach home, ask 'home_assistant_manager' to turn on the room lights.'

// - When im not at home turn off all the lights every day.
// You: Request 'event_manager' the following: 'I leave home, ask 'home_assistant_manager' to turn off all the lights. Make this listener a recurring one, also as this is recurring and mundane it doesnt make sense to notify the user every time, so notify can be false.'

// - When I get a message on WhatsApp from Pooja, reply that I'm driving.
// You: Request 'event_manager' the following: 'When a whatsapp message is received AND its from Pooja, ask 'communication_manager' to message Pooja the following message: "Raj is driving right now.".'

// You can send these request directly to the event manager, you can add any more details if needed as you have more context about the user and conversation.

// **Available Events:**
// ${JSON.stringify(events)}
// `,
//     },
//     {
//       role: "system",
//       content: `# **actions_manager**
// Use the actions manager to execute actions in a specific schedule or after a duration.

// - An action is a single instruction to execute at a specified time or after a duration.
// - Use this manager when the user wants something to happen at a specific time or after a duration.
// - When including tool names that are required for the action, ensure that you describe the tool's role in the action in detail.

// **Examples:**
// - User: Send me a message at 6 PM.
//   Action Instruction: Notify user with some text at 6 PM.
//   Tool Names: none (no need to use any tool to notify the creator of the action)
//   Suggested time to run: 6:00 PM

// - User: Turn my Fan off every morning.
//   Request: Ask 'home_assistant_manager' to turn off the fan every morning.
//   Tool Names: ["home_assistant_manager"]
//   Suggested time to run: 8:00 AM Every day

// - Every Evening, show me yesterday's gym stats.
//   Request: Fetch yesterday's gym stats by asking 'notes_manager' and send it to the user every evening.
//   Tool Names: ["notes_manager"]
//   Suggested time to run: 6:00 PM Every day

// - Tomorrow morning ping pooja that its an important day.
//   Action Instruction: Tomorrow morning 8am ask 'communication_manager' to send a message to Pooja that it's an important day.
//   Tool Names: ["communication_manager"]
//   Suggested time to run: 8:00 AM Tomorrow`,
//     },
//   ];

//   const creator_system_messages: OpenAI.ChatCompletionSystemMessageParam[] = [
//     {
//       role: "system",
//       content: `
// ## General Guidelines for Using Tool Managers

// ### Introduction
// Tool managers are specialized systems designed to handle distinct tasks with precision. Each manager can maintain context across interactions, which makes them highly efficient for managing state and providing relevant follow-up actions. Your goal is to make efficient use of these tools by providing the right amount of detail and ensuring each prompt is tailored to the specific task.

// - **Validate Responses**: Always validate the output from the manager. If the response does not fully meet the user's needs, refine the prompt and request again.
// - **Detailed Prompts**: Managers work best with detailed, clear prompts. Include user details and all pertinent information when applicable.
// - **Multi-Manager Coordination**: When multiple managers are needed, explicitly pass the necessary context and data between them.

// ### Important Guidelines
// - **State Maintenance**: Each manager retains context across calls, allowing follow-up questions or requests.
// - **Memory Usage**: Determine whether a memory is better saved within a manager or by the system itself.
//   - Use **memory_manager** for persistent user-defined rules or instructions across interactions.
//   - Remember simple routing instructions internally when appropriate.
// - **Explicit Information Sharing**: Managers cannot communicate directly. If you need information from one manager to use in another, make sure to explicitly request and pass it.

// #### Example Scenarios
// - **User Request**: "Send my gym notes to Dad."
//   - **Your Actions**: First, use \`notes_manager\` to fetch the gym notes, then use \`communication_manager\` to send those notes to Dad.

// - **User Request**: "When I say 'holy moly,' send a message to Pooja."
//   - **Your Actions**: Use \`memory_manager\` to remember that "holy moly" means sending a specific message to Pooja.

// ## Events Manager

// ### Purpose
// The **events_manager** is used to listen for and act on external events. It allows you to create event listeners that can trigger actions when specific conditions are met.

// ### How to Use
// - Each event can have multiple listeners, and each listener must have an instruction defining the action to take.
// - Use this manager whenever a user wants an action based on an external trigger, such as receiving an email or arriving at a specific location.

// ### Common Use Cases
// 1. **Email Forwarding**: "When I get an email, send it to Dad on WhatsApp."
//    - **Your Action**: Set up an event listener to trigger \`communication_manager\` when an email is received, sending it to Dad on WhatsApp.

// 2. **Home Automation**: "When I get home, turn on my room lights."
//    - **Your Action**: Set up an event listener to trigger \`home_assistant_manager\` to turn on the lights when the user arrives home.

// 3. **Recurring Actions**: "When I leave home, turn off all the lights every day."
//    - **Your Action**: Set up a recurring listener that triggers \`home_assistant_manager\` to turn off all lights when the user leaves home. Set \`notify\` to false for mundane recurring events.

// ### Available Events
// ${JSON.stringify(data.events)}

// ## Actions Manager

// ### Purpose
// The **actions_manager** handles scheduled actions, executing specific tasks either at a particular time or after a given duration.

// ### How to Use
// - **Single Instruction**: An action is a single instruction to be executed at a set time or after a defined delay.
// - **Tool Specification**: When specifying an action, include which tools are required and describe their role clearly.

// ### Common Use Cases
// 1. **Reminder Notification**: "Send me a reminder at 6 PM."
//    - **Your Action**: Notify the user at 6 PM. No tools are required.

// 2. **Home Automation**: "Turn my fan off every morning."
//    - **Your Action**: Use \`home_assistant_manager\` to turn off the fan at 8 AM daily.

// 3. **Daily Updates**: "Every evening, show me yesterday's gym stats."
//    - **Your Action**: Use \`notes_manager\` to fetch yesterday's gym stats and send them to the user at 6 PM daily.

// ### Formatting Tips
// - **Time-Based Requests**: Use standard time formats to specify when an action should occur.
// - **Include Tool Names**: Explicitly state which managers are involved in the action and describe their roles.

// ## Best Practices for Prompting Managers
// - **Formatting**: Use bullet points or numbered steps for clarity.
// - **Detail Level**: Provide all relevant information—names, tasks, specific times, etc.—to ensure the manager has the right context.
// - **Avoid Redundancy**: Be concise and avoid repeating details unless necessary for clarity.

// ### Example Scenario for Multi-Step Interaction
// - **User Request**: "Send Pooja my location when I reach work."
//   - **Your Actions**:
//     1. Use \`events_manager\` to listen for the "reaching work" event.
//     2. When the event occurs, use \`communication_manager\` to send the user's location to Pooja.

// This approach ensures the prompt is organized, easy to navigate, and contains all the relevant information needed for efficient interactions with the different managers. It balances detail with readability and provides concrete examples to guide usage. Let me know if you'd like further adjustments or specific sections expanded!
// `,
//     },
//   ];
