import { PlatformAdapter, FetchOptions } from "./platform-adapter";
import {
  Message as StdMessage,
  SentMessage,
  User as StdUser,
  Attachment,
  User as StdMessageUser,
} from "./message";
import {
  Client,
  GatewayIntentBits,
  Message as DiscordMessage,
  TextChannel,
  Partials,
  ChannelType,
  ActivityType,
  User as DiscordUser,
  DMChannel,
} from "discord.js";
import { UserConfig, userConfigs } from "../config";

export class DiscordAdapter implements PlatformAdapter {
  private client: Client;
  private botUserId: string = "";

  private readonly MAX_MESSAGE_LENGTH = 2000;
  private readonly TRUNCATED_MESSAGE_LENGTH = 1500;

  public config = {
    indicators: {
      typing: true,
      processing: true,
    },
  };

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    this.client.on("ready", () => {
      console.log(`Logged in as ${this.client.user?.tag}!`);
      this.botUserId = this.client.user?.id || "";
      this.client.user?.setActivity("as Human", {
        type: Number(ActivityType.Playing),
      });
    });

    this.client.login(process.env.DISCORD_BOT_TOKEN);
  }

  public getUserById(userId: string): UserConfig | null {
    const userConfig = userConfigs.find((user) =>
      user.identities.some(
        (identity) => identity.platform === "discord" && identity.id === userId
      )
    );

    if (!userConfig) {
      return null;
    }

    return userConfig;
  }

  public onMessage(callback: (message: StdMessage) => void): void {
    this.client.on("messageCreate", async (discordMessage: DiscordMessage) => {
      if (discordMessage.author.bot) return;

      if (discordMessage.channel.type !== ChannelType.DM) {
        return;
      }

      // if user does not exist in userConfigs dont reply
      const userConfig = this.getUserById(discordMessage.author.id);
      if (!userConfig) {
        return;
      }

      const message = await this.convertMessage(discordMessage);
      callback(message);
    });
  }

  public async sendMessage(channelId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (
      channel?.type !== ChannelType.GuildText &&
      channel?.type !== ChannelType.DM
    ) {
      console.error("Invalid channel type", channel?.type, channelId);
      return;
    }
    await this.safeSend(channel as TextChannel, content);
  }

  public async fetchMessageById(
    channelId: string,
    messageId: string
  ): Promise<StdMessage | null> {
    const channel = await this.client.channels.fetch(channelId);
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.DM)
    ) {
      throw new Error("Invalid channel type");
    }

    try {
      const discordMessage = await (channel as TextChannel).messages.fetch(
        messageId
      );
      const stdMessage = await this.convertMessage(discordMessage);
      return stdMessage;
    } catch (error) {
      console.error(`Failed to fetch message by ID: ${error}`);
      return null;
    }
  }
  public async fetchMessages(
    channelId: string,
    options: FetchOptions
  ): Promise<StdMessage[]> {
    const channel = await this.client.channels.fetch(channelId);
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.DM)
    ) {
      throw new Error("Invalid channel type");
    }

    const messages = await (channel as TextChannel).messages.fetch({
      limit: options.limit || 10,
    });
    const stdMessages: StdMessage[] = [];

    for (const msg of messages.values()) {
      const stdMsg = await this.convertMessage(msg);
      stdMessages.push(stdMsg);
    }

    // Return messages in chronological order
    return stdMessages;
  }

  public getBotId(): string {
    return this.botUserId;
  }

  public async sendSystemLog(content: string) {
    if (process.env.DISCORD_LOG_CHANNEL_ID)
      return await this.sendMessage(
        process.env.DISCORD_LOG_CHANNEL_ID || "",
        content
      );
  }

  public async searchUser(query: string): Promise<StdMessageUser[]> {
    const users = this.client.users.cache;
    return users
      .filter((user) =>
        user.username.toLowerCase().includes(query.toLowerCase())
      )
      .map((user) => ({
        id: user.id,
        username: user.username,
        config: this.getUserById(user.id),
      }));
  }

  // Method to create a Message interface for a user ID
  public async createMessageInterface(userId: string): Promise<StdMessage> {
    try {
      const user = await this.client.users.fetch(userId);

      console.log("creating message interface for: ", userId, user.username);

      const stdMessage: StdMessage = {
        platform: "discord",
        platformAdapter: this,
        id: userId,
        author: {
          id: userId,
          username: user.username,
          config: this.getUserById(userId),
        },
        content: "",
        timestamp: new Date(),
        channelId: "",
        source: null,
        threadId: undefined,
        isDirectMessage: async () => true,
        send: async (messageData) => {
          const sentMessage = await this.safeSend(user, messageData);
          return this.convertSentMessage(sentMessage);
        },
        reply: async (messageData) => {
          const sentMessage = await this.safeSend(user, messageData);
          return this.convertSentMessage(sentMessage);
        },
        getUserRoles: () => {
          const userConfig = userConfigs.find((userConfig) =>
            userConfig.identities.some(
              (identity) =>
                identity.platform === "discord" && identity.id === userId
            )
          );
          return userConfig ? userConfig.roles : ["user"];
        },
        sendDirectMessage: async (userId, messageData) => {
          const user = await this.client.users.fetch(userId);
          console.log("sending message to: ", userId);
          await this.safeSend(user, messageData);
        },
        sendMessageToChannel: async (channelId, messageData) => {
          const channel = await this.client.channels.fetch(channelId);
          if (channel?.isTextBased()) {
            await this.safeSend(channel as TextChannel, messageData);
          }
        },
        fetchChannelMessages: async (limit: number) => {
          const messages = await user.dmChannel?.messages.fetch({ limit });
          return Promise.all(
            messages?.map((msg) => this.convertMessage(msg)) || []
          );
        },
        sendFile: async (fileUrl, fileName) => {
          const messageData = {
            files: [{ attachment: fileUrl, name: fileName }],
          };
          await this.safeSend(user, messageData);
        },
        sendTyping: async () => {
          await user.dmChannel?.sendTyping();
        },
      };

      return stdMessage;
    } catch (error) {
      throw new Error(
        `Failed to create message interface for Discord user ${userId}: ${error}`
      );
    }
  }

  // Expose getMessageInterface method
  public getMessageInterface = this.createMessageInterface;

  private async convertMessage(
    discordMessage: DiscordMessage
  ): Promise<StdMessage> {
    const stdUser: StdUser = {
      id: discordMessage.author.id,
      username: discordMessage.author.username,
      config: this.getUserById(discordMessage.author.id),
    };

    const attachments: Attachment[] = discordMessage.attachments.map(
      (attachment) => ({
        url: attachment.url,
        contentType: attachment.contentType || undefined,
      })
    );

    const stdMessage: StdMessage = {
      id: discordMessage.id,
      content: discordMessage.content,
      platformAdapter: this,
      author: stdUser,
      timestamp: discordMessage.createdAt,
      channelId: discordMessage.channelId,
      threadId: discordMessage.reference?.messageId || undefined,
      source: discordMessage,
      platform: "discord",
      attachments,
      isDirectMessage: async () =>
        discordMessage.channel.type === ChannelType.DM,
      send: async (messageData) => {
        const sentMessage = await this.safeSend(
          discordMessage.channel as TextChannel,
          messageData
        );
        return this.convertSentMessage(sentMessage);
      },
      reply: async (messageData) => {
        const sentMessage = await this.safeReply(discordMessage, messageData);
        return this.convertSentMessage(sentMessage);
      },
      getUserRoles: () => {
        const userConfig = userConfigs.find((user) =>
          user.identities.some(
            (identity) =>
              identity.platform === "discord" &&
              identity.id === discordMessage.author.id
          )
        );
        return userConfig ? userConfig.roles : ["user"];
      },
      sendDirectMessage: async (userId, messageData) => {
        const user = await this.client.users.fetch(userId);
        await this.safeSend(user, messageData);
      },
      sendMessageToChannel: async (channelId, messageData) => {
        const channel = await this.client.channels.fetch(channelId);
        if (channel?.isTextBased()) {
          await this.safeSend(channel as TextChannel, messageData);
        }
      },
      fetchChannelMessages: async (limit: number) => {
        const messages = await discordMessage.channel.messages.fetch({ limit });
        return Promise.all(messages.map((msg) => this.convertMessage(msg)));
      },
      sendFile: async (fileUrl, fileName) => {
        const messageData = {
          files: [{ attachment: fileUrl, name: fileName }],
        };
        await this.safeSend(discordMessage.channel as TextChannel, messageData);
      },
      sendTyping: async () => {
        await (discordMessage.channel as TextChannel).sendTyping();
      },
    };

    return stdMessage;
  }

  private convertSentMessage(discordMessage: DiscordMessage): SentMessage {
    return {
      id: discordMessage.id,
      platformAdapter: this,
      content: discordMessage.content,
      author: {
        id: discordMessage.author.id,
        username: discordMessage.author.username,
        config: this.getUserById(discordMessage.author.id),
      },
      timestamp: discordMessage.createdAt,
      channelId: discordMessage.channelId,
      threadId: discordMessage.reference?.messageId || undefined,
      source: discordMessage,
      platform: "discord",
      deletable: discordMessage.deletable,
      delete: async () => {
        if (discordMessage.deletable) {
          await discordMessage.delete();
        }
      },
      edit: async (data) => {
        await this.safeEdit(discordMessage, data);
      },
      getUserRoles: () => {
        // Since this is a message sent by the bot, return bot's roles or empty array
        return [];
      },
      isDirectMessage: async () =>
        discordMessage.channel.type === ChannelType.DM,
      sendDirectMessage: async (userId, messageData) => {
        const user = await this.client.users.fetch(userId);
        await this.safeSend(user, messageData);
      },
      sendMessageToChannel: async (channelId, messageData) => {
        const channel = await this.client.channels.fetch(channelId);
        if (channel?.isTextBased()) {
          await this.safeSend(channel as TextChannel, messageData);
        }
      },
      fetchChannelMessages: async (limit: number) => {
        const messages = await discordMessage.channel.messages.fetch({ limit });
        return Promise.all(messages.map((msg) => this.convertMessage(msg)));
      },
      sendFile: async (fileUrl, fileName) => {
        const messageData = {
          files: [{ attachment: fileUrl, name: fileName }],
        };
        await this.safeSend(discordMessage.channel as TextChannel, messageData);
      },
      sendTyping: async () => {
        await (discordMessage.channel as TextChannel).sendTyping();
      },
      reply: async (messageData) => {
        const sentMessage = await this.safeReply(discordMessage, messageData);
        return this.convertSentMessage(sentMessage);
      },
      send: async (messageData) => {
        const sentMessage = await this.safeSend(
          discordMessage.channel as TextChannel,
          messageData
        );
        return this.convertSentMessage(sentMessage);
      },
    };
  }

  // Helper method to safely send messages with length checks
  private async safeSend(
    target: TextChannel | DiscordUser,
    messageData: string | { content?: string; [key: string]: any }
  ): Promise<DiscordMessage> {
    let content: string | undefined;
    if (typeof messageData === "string") {
      content = messageData;
    } else if (messageData.content) {
      content = messageData.content;
    }

    if (content && content.length > this.MAX_MESSAGE_LENGTH) {
      content = content.slice(0, this.TRUNCATED_MESSAGE_LENGTH);
      if (typeof messageData === "string") {
        messageData = content;
      } else {
        messageData.content = content;
      }
    }

    if (target instanceof DiscordUser) {
      // Ensure the DM channel is created before sending
      const dmChannel = await target.createDM();
      return await dmChannel.send(messageData);
    } else {
      return await target.send(messageData);
    }
  }

  // Helper method to safely reply with length checks
  private async safeReply(
    message: DiscordMessage,
    messageData: string | { content?: string; [key: string]: any }
  ): Promise<DiscordMessage> {
    let content: string | undefined;
    if (typeof messageData === "string") {
      content = messageData;
    } else if (messageData.content) {
      content = messageData.content;
    }

    if (content && content.length > this.MAX_MESSAGE_LENGTH) {
      content = content.slice(0, this.TRUNCATED_MESSAGE_LENGTH);
      if (typeof messageData === "string") {
        messageData = content;
      } else {
        messageData.content = content;
      }
    }

    return await message.reply(messageData);
  }

  // Helper method to safely edit messages with length checks
  private async safeEdit(
    message: DiscordMessage,
    data: string | { content?: string; [key: string]: any }
  ): Promise<DiscordMessage> {
    let content: string | undefined;
    if (typeof data === "string") {
      content = data;
    } else if (data.content) {
      content = data.content;
    }

    if (content && content.length > this.MAX_MESSAGE_LENGTH) {
      content = content.slice(0, this.TRUNCATED_MESSAGE_LENGTH);
      if (typeof data === "string") {
        data = content;
      } else {
        data.content = content;
      }
    }

    return await message.edit(data);
  }
}
