// tools/tokio.ts

import { z } from "zod";
import { Message } from "../interfaces/message";
import { userConfigs } from "../config";
import fs from "fs";
import path from "path";
import { getMessageInterface } from "../interfaces";

// Utility function to get user ID by name and platform
function getUserIdByName(
  userName: string,
  platform: string
): string | undefined {
  const userConfig = userConfigs.find(
    (user) => user.name.toLowerCase() === userName.toLowerCase()
  );
  if (userConfig) {
    const identity = userConfig.identities.find(
      (id) => id.platform === platform
    );
    return identity?.id;
  }
  return undefined;
}

// SendMessageParams schema
export const SendMessageParams = z.object({
  user_id: z
    .string()
    .describe(
      "The user id of the user specific to the platform selected. This will be different from the user's name and depends on the platform."
    ),
  content: z
    .string()
    .describe(
      "The message to send to the user. Make sure to include the name of the person who asked you to send the message. You can only link HTTP URLs in links; you cannot link file paths EVER."
    )
    .optional(),
  platform: z.string().describe("The platform to send the message to."),
  embeds: z
    .array(
      z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        url: z.string().optional(),
        color: z.number().optional(),
        timestamp: z.string().optional(),
        footer: z
          .object({
            text: z.string(),
            icon_url: z.string().optional(),
          })
          .optional(),
        image: z
          .object({
            url: z.string(),
          })
          .optional(),
        thumbnail: z
          .object({
            url: z.string(),
          })
          .optional(),
      })
    )
    .optional()
    .describe(
      "Embeds to send. Include the name of the person who asked you to send the message in the footer as the from user."
    ),
  files: z
    .array(
      z.object({
        attachment: z.string().describe("URL/path to file to send"),
        name: z.string(),
      })
    )
    .optional(),
});
export type SendMessageParams = z.infer<typeof SendMessageParams>;

// Function to send a message to a user
export async function send_message_to(
  { content, embeds, files, user_id, platform: plat }: SendMessageParams,
  context_message: Message
) {
  if (!plat) {
    return { error: "Please specify a platform" };
  }

  const platform = (plat || context_message.platform).toLocaleLowerCase();
  if (
    !context_message.getUserRoles().includes("admin") &&
    platform === "whatsapp"
  ) {
    return {
      error:
        "You need to be Raj to send messages on WhatsApp, you are not allowed",
    };
  }

  if (platform === "whatsapp") {
    const roles = context_message.getUserRoles();
    if (!roles.includes("admin")) {
      return { error: "User is not allowed to send messages on WhatsApp." };
    }
  }

  // if platform is whatsapp and user_id does not end with @c.us, add it
  if (platform === "whatsapp" && user_id && !user_id.endsWith("@c.us")) {
    user_id = user_id + "@c.us";
  }
  // Get the recipient's user ID
  let toUserId: string | undefined = user_id;

  try {
    // Prepare the message data
    const messageData = { content, embeds, files };
    if (user_id) {
      if (plat !== context_message.platform) {
        const local_ctx = await getMessageInterface({
          platform: plat || platform,
          id: user_id,
        });
        try {
          await local_ctx.send(messageData);
          return {
            response: "Message sent",
          };
        } catch (error) {
          return {
            error,
          };
        }
      }
    }

    if (!toUserId) {
      return { error: "User not found on this platform." };
    }

    if (!content && !embeds && !files) {
      return {
        error: "At least one of content, embeds, or files is required.",
      };
    }

    await context_message.sendDirectMessage(toUserId, messageData);
    return {
      response:
        "Message sent, generate notification text telling that message was successfully sent.",
      note:
        toUserId === context_message.author.id
          ? `The message was sent to the user. Reply to the user with "<NOREPLY>" as you already sent them a message.`
          : "The message was sent to the user. You can also tell what you sent the user if required.",
    };
  } catch (error: any) {
    return { error: error.message || error };
  }
}

// SendGeneralMessageParams schema
export const SendGeneralMessageParams = z.object({
  channel_id: z
    .string()
    .optional()
    .describe("Channel ID to send the message to."),
  content: z
    .string()
    .describe(
      "The message to send. Make sure to include the name of the person who asked you to send the message. You can only link HTTP URLs in links; you cannot link file paths EVER."
    )
    .optional(),
  embeds: z
    .array(
      z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        url: z.string().optional(),
        color: z.number().optional(),
        timestamp: z.string().optional(),
        footer: z
          .object({
            text: z.string(),
            icon_url: z.string().optional(),
          })
          .optional(),
        image: z
          .object({
            url: z.string(),
          })
          .optional(),
        thumbnail: z
          .object({
            url: z.string(),
          })
          .optional(),
      })
    )
    .optional()
    .describe(
      "Embeds to send. Include the name of the person who asked you to send the message in the footer as the from user."
    ),
  files: z
    .array(
      z.object({
        attachment: z.string().describe("URL/path to file to send"),
        name: z.string(),
      })
    )
    .optional(),
});
export type SendGeneralMessageParams = z.infer<typeof SendGeneralMessageParams>;

// Function to send a message to a channel
export async function send_general_message(
  { channel_id, content, embeds, files }: SendGeneralMessageParams,
  context_message: Message
) {
  const platform = context_message.platform;

  // Use the provided channel ID or default to the current channel
  const targetChannelId = channel_id || context_message.channelId;

  if (!targetChannelId) {
    return { error: "Channel ID is required." };
  }

  if (!content && !embeds && !files) {
    return { error: "At least one of content, embeds, or files is required." };
  }

  try {
    // Prepare the message data
    const messageData = { content, embeds, files };

    await context_message.sendMessageToChannel(targetChannelId, messageData);
    return {
      response: "Message sent",
    };
  } catch (error: any) {
    return { error: error.message || error };
  }
}
