import { PlatformAdapter, FetchOptions } from "./platform-adapter";
import {
  Message as StdMessage,
  SentMessage,
  User as StdUser,
  Attachment,
  User,
} from "./message";
import {
  Client,
  GatewayIntentBits,
  Message as DiscordMessage,
  TextChannel,
  Partials,
  ChannelType,
  ActivityType,
} from "discord.js";
import { UserConfig, userConfigs } from "../config";

export class DiscordAdapter implements PlatformAdapter {
  private client: Client;
  private botUserId: string = "";

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
    await (channel as TextChannel).send(content);
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

  public async searchUser(query: string): Promise<User[]> {
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
          const sentMessage = await user.send(messageData);
          return this.convertSentMessage(sentMessage);
        },
        reply: async (messageData) => {
          const sentMessage = await user.send(messageData);
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
          await user.send(messageData);
        },
        sendMessageToChannel: async (channelId, messageData) => {
          const channel = await this.client.channels.fetch(channelId);
          if (channel?.isTextBased()) {
            await (channel as TextChannel).send(messageData);
          }
        },
        fetchChannelMessages: async (limit: number) => {
          const messages = await user.dmChannel?.messages.fetch({ limit });
          return Promise.all(
            messages?.map((msg) => this.convertMessage(msg)) || []
          );
        },
        sendFile: async (fileUrl, fileName) => {
          await user.dmChannel?.send({
            files: [{ attachment: fileUrl, name: fileName }],
          });
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

  // You may also need to expose this method so it can be accessed elsewhere
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
        const sentMessage = await (discordMessage.channel as TextChannel).send(
          messageData
        );
        return this.convertSentMessage(sentMessage);
      },
      reply: async (messageData) => {
        const sentMessage = await discordMessage.reply(messageData);
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
        await user.send(messageData);
      },
      sendMessageToChannel: async (channelId, messageData) => {
        const channel = await this.client.channels.fetch(channelId);
        if (channel?.isTextBased()) {
          await (channel as TextChannel).send(messageData);
        }
      },
      fetchChannelMessages: async (limit: number) => {
        const messages = await discordMessage.channel.messages.fetch({ limit });
        return Promise.all(messages.map((msg) => this.convertMessage(msg)));
      },
      sendFile: async (fileUrl, fileName) => {
        await (discordMessage.channel as TextChannel).send({
          files: [{ attachment: fileUrl, name: fileName }],
        });
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
        await discordMessage.edit(data);
      },
      getUserRoles: () => {
        // Since this is a message sent by the bot, return bot's roles or empty array
        return [];
      },
      isDirectMessage: async () =>
        discordMessage.channel.type === ChannelType.DM,
      sendDirectMessage: async (userId, messageData) => {
        const user = await this.client.users.fetch(userId);
        await user.send(messageData);
      },
      sendMessageToChannel: async (channelId, messageData) => {
        const channel = await this.client.channels.fetch(channelId);
        if (channel?.isTextBased()) {
          await (channel as TextChannel).send(messageData);
        }
      },
      fetchChannelMessages: async (limit: number) => {
        const messages = await discordMessage.channel.messages.fetch({ limit });
        return Promise.all(messages.map((msg) => this.convertMessage(msg)));
      },
      sendFile: async (fileUrl, fileName) => {
        await (discordMessage.channel as TextChannel).send({
          files: [{ attachment: fileUrl, name: fileName }],
        });
      },
      sendTyping: async () => {
        await (discordMessage.channel as TextChannel).sendTyping();
      },
      reply: async (messageData) => {
        const sentMessage = await discordMessage.reply(messageData);
        return this.convertSentMessage(sentMessage);
      },
      send: async (messageData) => {
        const sentMessage = await (discordMessage.channel as TextChannel).send(
          messageData
        );
        return this.convertSentMessage(sentMessage);
      },
    };
  }
}
