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
  prefered_recipient_details: z
    .object({
      name: z.string().optional(),
      user_id: z.string().optional(),
    })
    .optional()
    .describe("Give these details only if you have them."),
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
    prefered_recipient_details,
  }: CommunicationManager,
  context_message: Message
) {
  const tools = communication_tools(context_message).concat(
    memory_manager_init(context_message, "communications_manager")
  );

  const prompt = `You are a Communication Manager Tool.

Your task is to route messages to the correct recipient.

It is extremely important that the right message goes to the right user, and never to the wrong user.

---

${memory_manager_guide("communications_manager")}

You can use the \`memory_manager\` tool to remember user preferences, such as what the user calls certain contacts, to help you route messages better.

---

**Default Platform (if not mentioned):** ${context_message.platform}

**Configuration of All Users:** ${JSON.stringify(userConfigs)}

**Can Access 'WhatsApp':** ${context_message.getUserRoles().includes("creator")}

**Guidelines:**

- If the user does not mention a platform, use the same platform as the current user.

- Look for the recipient's details in the user configuration before checking WhatsApp users.

- If the recipient is not on the current user's platform and the user can access WhatsApp, you may check if the recipient is on WhatsApp. Confirm the WhatsApp number (WhatsApp ID) with the user before sending the message.

- Check WhatsApp only if the user can access it and the recipient is not found in the user config or if the user explicitly asks to send the message on WhatsApp.
`;

  const response = await ask({
    prompt,
    message: `request: ${request}

    prefered_platform: ${prefered_platform}
    
    prefered_recipient_details: ${JSON.stringify(prefered_recipient_details)}`,
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
    description: `Communications Manager.

This tool routes messages to the specified user on the appropriate platform.

Use it to send messages to users on various platforms.

Provide detailed information to ensure the message reaches the correct recipient.

Include in your request the message content and the recipient's details.

**Example:**

- **User:** "Tell Pooja to call me."
- **Sender's Name:** Raj
- **Recipient's Name:** Pooja
- **Generated Request String:** "Raj wants to message Pooja 'call me'. Seems like he's in a hurry, so you can format it to sound urgent."
`,
  });
