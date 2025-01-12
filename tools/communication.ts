import { z } from "zod";
import { zodFunction } from ".";
import { send_message_to, SendMessageParams } from "./messenger";
import { send_email, ResendParams } from "./resend";
import { Message } from "../interfaces/message";
import { search_user, SearchUserParams } from "./search-user";
import { RunnableToolFunctionWithParse } from "openai/lib/RunnableFunction.mjs";
import { ask } from "./ask";
import { memory_manager_guide, memory_manager_init } from "./memory-manager";
import { userConfigs } from "../config";

const CommunicationManagerSchema = z.object({
  request: z.string(),
  prefered_platform: z
    .string()
    .optional()
    .describe(
      "The platform you prefer to use, you can leave this empty to default to the current user's platform."
    ),
  // prefered_recipient_details: z
  //   .object({
  //     name: z.string().optional(),
  //     user_id: z.string().optional(),
  //   })
  //   .optional()
  //   .describe("Give these details only if you have them."),
});

export type CommunicationManager = z.infer<typeof CommunicationManagerSchema>;

const communication_tools = (context_message: Message) => {
  const allTools: RunnableToolFunctionWithParse<any>[] = [
    zodFunction({
      function: (args) => search_user(args, context_message),
      name: "search_user",
      schema: SearchUserParams,
      description: `Retrieve a user's details (email or platform IDs) by searching their name.

Supported platforms: ['whatsapp', 'discord', 'email', 'events']`,
    }),
    zodFunction({
      function: (args) => send_message_to(args, context_message),
      name: "send_message_to",
      schema: SendMessageParams,
      description: `Send a message to a user or relation using their config name or user ID.

- **Current user's platform:** ${context_message.platform}
- If no platform is specified, use the current user's platform unless specified otherwise.
- If no \`user_name\` is provided, the message will be sent to the current user.
- Use \`search_user\` to obtain the \`user_id\`.
- Supported platforms: ['whatsapp', 'discord']

**Note:** When sending a message on behalf of someone else, mention who is sending it. For example, if Pooja asks you to remind Raj to drink water, send: "Pooja wanted to remind you to drink water."`,
    }),
    zodFunction({
      function: send_email,
      schema: ResendParams,
      description: `Send an email to a specified email address.

- Confirm the recipient's email with the user before sending.
- Use \`search_user\` to get the email if only a name is provided.
- Do not invent an email address if none is found.`,
    }),
  ];

  return allTools;
};

export async function communication_manager(
  {
    request,
    prefered_platform,
    // prefered_recipient_details,
  }: CommunicationManager,
  context_message: Message
) {
  const tools = communication_tools(context_message).concat(
    memory_manager_init(context_message, "communications_manager")
  );

  const prompt = `You are a Communication Manager Tool responsible for routing messages to the correct recipients.

CONTEXT INFORMATION:
1. Current User (Sender): ${context_message.author.config?.name}
2. Current Platform: ${context_message.platform}
3. WhatsApp Access: ${context_message.getUserRoles().includes("creator")}
4. Available Platforms: discord, whatsapp, email

STEP-BY-STEP PROCESS:
1. First, identify the recipient(s) from the request
2. Then, check if recipient exists in this list of known users:
${JSON.stringify(userConfigs, null, 2)}

3. If recipient not found in above list:
   - Use search_user tool to find them
   - Wait for search results before proceeding

4. Platform Selection:
   - If prefered_platform is specified, use that
   - If not specified, use current platform: ${context_message.platform}
   - For WhatsApp, verify you have creator access first

TOOLS AVAILABLE:
- search_user: Find user details by name
- send_message_to: Send message on discord/whatsapp
- send_email: Send emails (requires verified email address)
- memory_manager: Store user preferences and contact names

${memory_manager_guide("communications_manager", context_message.author.id)}

MESSAGE DELIVERY GUIDELINES:
Act as a professional assistant delivering messages between people. Consider:

1. Relationship Context:
   - Professional for workplace communications
   - Casual for friends and family
   - Respectful for all contexts

2. Message Delivery Style:
   - Frame the message naturally as an assistant would when passing along information
   - Maintain the original intent and tone of the sender
   - Add appropriate context without changing the core message

3. Natural Communication:
   - Deliver messages as if you're the assistant of the user: ${context_message.author.config?.name}.
   - Adapt your tone based on the message urgency and importance
   - Include relevant context when delivering reminders or requests
   - Keep the human element in the communication

Remember: You're not just forwarding messages, you're acting as a professional assistant helping facilitate communication between people. Make your delivery natural and appropriate for each situation.

ERROR PREVENTION:
- Don't halucinate or invent contact details
- Always verify platform availability before sending
- If unsure about recipient, ask for clarification
`;

  const response = await ask({
    prompt,
    model: "gpt-4o-mini",
    message: `request: ${request}

    prefered_platform: ${prefered_platform}`,
    tools,
  });

  try {
    return {
      response: response.choices[0].message,
    };
  } catch (error) {
    return {
      error,
    };
  }
}

export const communication_manager_tool = (context_message: Message) =>
  zodFunction({
    function: (args) => communication_manager(args, context_message),
    name: "communication_manager",
    schema: CommunicationManagerSchema,
    description: `Sends messages to one or more recipients across different platforms (discord, whatsapp, email).

Input format:
request: "send [message] to [recipient(s)]"
prefered_platform: (optional) platform name

The tool handles recipient lookup, message composition, and delivery automatically.`,
  });
