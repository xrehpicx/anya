import { PlatformAdapter, FetchOptions } from "./platform-adapter";
import {
  Message as StdMessage,
  User as StdUser,
  SentMessage,
  Attachment,
} from "./message";
import {
  Client as WAClient,
  Message as WAMessage,
  LocalAuth,
  MessageMedia,
} from "whatsapp-web.js";
import { UserConfig, userConfigs } from "../config";
// import { eventManager } from "./events";
import { return_current_listeners } from "../tools/events";
import Fuse from "fuse.js";
import { get_transcription } from "../tools/ask";  // Add this import

export class WhatsAppAdapter implements PlatformAdapter {
  private client: WAClient;

  public config = {
    indicators: {
      typing: true,
      processing: false,
    },
  };

  constructor() {
    this.client = new WAClient({
      authStrategy: new LocalAuth(),
    });
    try {
      this.client.on("ready", () => {
        console.log("WhatsApp Client is ready!");
      });

      this.client.on("qr", (qr) => {
        console.log("QR Code received. Please scan with WhatsApp:");
        console.log(qr);
      });

      this.client.initialize();
    } catch (error) {
      console.log(`Failed to initialize WhatsApp client: `, error);
    }
  }
  public getUserById(userId: string): UserConfig | null {
    const userConfig = userConfigs.find((user) =>
      user.identities.some(
        (identity) =>
          identity.platform === "whatsapp" && `${identity.id}@c.us` === userId
      )
    );

    if (!userConfig) {
      // console.log(`User not found for WhatsApp ID: ${userId}`);
      return null;
    }

    return userConfig;
  }

  public onMessage(callback: (message: StdMessage) => void): void {
    this.client.on("message_create", async (waMessage: WAMessage) => {


      // emit internal event only if text message and there is an active listener
      const listeners = return_current_listeners();
      if (
        typeof waMessage.body === "string" &&
        !waMessage.fromMe &&
        listeners.find((l) => l.eventId.includes("whatsapp"))
      ) {
        // const contact = await this.client.getContactById(waMessage.from);
        // eventManager.emit("got_whatsapp_message", {
        //   sender_id: waMessage.from,
        //   sender_contact_name:
        //     contact.name || contact.shortName || contact.pushname || "NA",
        //   timestamp: waMessage.timestamp,
        //   content: waMessage.body,
        //   profile_image_url: await contact.getProfilePicUrl(),
        //   is_group_message: contact.isGroup.toString(),
        // });
      }

      // user must exist in userConfigs
      const usr = this.getUserById(waMessage.from);
      if (!usr) {
        console.log(`Ignoring ID: ${waMessage.from}`);
        return;
      }

      // // user must be in allowedUsers
      // if (!allowedUsers.includes(usr.name)) {
      //   console.log(`User not allowed: ${usr.name}`, allowedUsers);
      //   return;
      // }

      // Ignore messages sent by the bot
      if (waMessage.fromMe) return;

      const message = await this.convertMessage(waMessage);

      callback(message);
    });
  }

  public async sendMessage(channelId: string, content: string): Promise<void> {
    await this.client.sendMessage(channelId, content);
  }

  public async fetchMessages(
    channelId: string,
    options: FetchOptions
  ): Promise<StdMessage[]> {
    const chat = await this.client.getChatById(channelId);
    const messages = await chat.fetchMessages({ limit: options.limit || 10 });

    const stdMessages: StdMessage[] = [];

    for (const msg of messages) {
      const stdMsg = await this.convertMessage(msg);
      stdMessages.push(stdMsg);
    }

    // Return messages in chronological order
    return stdMessages.reverse();
  }

  public getBotId(): string {
    return this.client.info.wid.user;
  }

  public async createMessageInterface(userId: string): Promise<StdMessage> {
    try {
      const contact = await this.client.getContactById(userId);
      const stdMessage: StdMessage = {
        platform: "whatsapp",
        platformAdapter: this,
        id: userId,
        author: {
          id: userId,
          username:
            contact.name || contact.shortName || contact.pushname || "NA",
          config: this.getUserById(userId),
        },
        content: "", // Placeholder content
        timestamp: new Date(), // Placeholder timestamp
        channelId: userId, // Assuming userId is the channelId
        source: null, // Placeholder source
        threadId: undefined, // Placeholder threadId
        isDirectMessage: async () => true,
        sendDirectMessage: async (recipientId, messageData) => {
          const tcontact = await this.client.getContactById(recipientId);
          const tchat = await tcontact.getChat();
          let media;
          if (messageData.file && "url" in messageData.file) {
            media = await MessageMedia.fromUrl(messageData.file.url);
          }
          if (messageData.file && "path" in messageData.file) {
            media = MessageMedia.fromFilePath(messageData.file.path);
          }

          await tchat.sendMessage(messageData.content || "", { media });
        },
        sendMessageToChannel: async (channelId, messageData) => {
          let media;
          if (messageData.file && "url" in messageData.file) {
            media = await MessageMedia.fromUrl(messageData.file.url);
          }
          if (messageData.file && "path" in messageData.file) {
            media = MessageMedia.fromFilePath(messageData.file.path);
          }
          await this.client.sendMessage(channelId, messageData.content || "", {
            media,
          });
        },
        sendFile: async (fileUrl, fileName) => {
          const media = MessageMedia.fromFilePath(fileUrl);
          await this.client.sendMessage(userId, media, {
            caption: fileName,
          });
        },
        fetchChannelMessages: async (limit: number) => {
          const chat = await this.client.getChatById(userId);
          const messages = await chat.fetchMessages({ limit });
          return Promise.all(messages.map((msg) => this.convertMessage(msg)));
        },
        getUserRoles: () => {
          const userConfig = userConfigs.find((user) =>
            user.identities.some(
              (identity) =>
                identity.platform === "whatsapp" && identity.id === userId
            )
          );
          return userConfig ? userConfig.roles : ["user"];
        },
        send: async (messageData) => {
          let media;
          if (messageData.file && "url" in messageData.file) {
            media = await MessageMedia.fromUrl(messageData.file.url);
          }
          if (messageData.file && "path" in messageData.file) {
            media = MessageMedia.fromFilePath(messageData.file.path);
          }
          const sentMessage = await this.client.sendMessage(
            userId,
            messageData.content || "",
            {
              media,
            }
          );
          return this.convertSentMessage(sentMessage);
        },
        reply: async (messageData) => {
          let media;
          if (messageData.file && "url" in messageData.file) {
            media = await MessageMedia.fromUrl(messageData.file.url);
          }
          if (messageData.file && "path" in messageData.file) {
            media = MessageMedia.fromFilePath(messageData.file.path);
          }

          const sentMessage = await this.client.sendMessage(
            userId,
            messageData.content || "",
            {
              media,
            }
          );
          return this.convertSentMessage(sentMessage);
        },
        sendTyping: async () => {
          // WhatsApp Web API does not support sending typing indicators directly
          // This method can be left as a no-op or you can implement a workaround if possible
        },
      };

      return stdMessage;
    } catch (error) {
      throw new Error(
        `Failed to create message interface for WhatsApp user ${userId}: ${error}`
      );
    }
  }
  async searchUser(query: string): Promise<StdUser[]> {
    try {
      const contacts = await this.client.getContacts();

      const stdcontacts = await Promise.all(
        contacts
          .filter((c) => c.isMyContact)
          .map(async (contact) => {
            return {
              id: contact.id._serialized,
              username:
                contact.pushname || contact.name || contact.shortName || "NA",
              config: this.getUserById(contact.id._serialized),
              meta: {
                about: contact.getAbout(),
                verifiedName: contact.verifiedName,
                shortName: contact.shortName,
                pushname: contact.pushname,
                name: contact.name,
                profilePicUrl: await contact.getProfilePicUrl(),
              },
            };
          })
      );

      console.log("Starting search");
      const fuse = new Fuse(stdcontacts, {
        keys: ["id", "username"],
        threshold: 0.3,
      });
      const results = fuse.search(query);
      console.log("search done", results.length);
      return results.map((result) => result.item);
    } catch (error) {
      throw new Error(`Failed to search for WhatsApp contacts: ${error}`);
    }
  }
  // Expose this method so it can be accessed elsewhere
  public getMessageInterface = this.createMessageInterface;

  public async handleMediaAttachment(attachment: Attachment) {
    if (!attachment.data) return { mediaType: 'other' as const };

    const buffer = Buffer.from(attachment.data as string, 'base64');

    if (attachment.type?.includes('image')) {
      const base64 = `data:${attachment.contentType};base64,${buffer.toString('base64')}`;
      return {
        base64,
        mediaType: 'image' as const
      };
    }

    if (attachment.type?.includes('audio')) {
      // Create temporary file for transcription
      const tempFile = new File([buffer], 'audio', { type: attachment.contentType });
      const transcription = await get_transcription(tempFile);
      return {
        transcription,
        mediaType: 'audio' as const
      };
    }

    return { mediaType: 'other' as const };
  }

  private async convertMessage(waMessage: WAMessage): Promise<StdMessage> {
    const contact = await waMessage.getContact();

    const stdUser: StdUser = {
      id: contact.id._serialized,
      username: contact.name || contact.shortName || contact.pushname || "NA",
      config: this.getUserById(contact.id._serialized),
    };

    // Convert attachments
    let attachments: Attachment[] = [];
    if (waMessage.hasMedia) {
      console.log("Downloading media...");
      const media = await waMessage.downloadMedia();

      const attachment: Attachment = {
        url: "",
        data: media.data,
        contentType: media.mimetype,
        type: waMessage.type
      };

      console.log("Processing media attachment...");

      const processedMedia = await this.handleMediaAttachment(attachment);
      console.log("Processed media attachment:", processedMedia.transcription);
      if (processedMedia.base64) attachment.base64 = processedMedia.base64;
      if (processedMedia.transcription) attachment.transcription = processedMedia.transcription;
      attachment.mediaType = processedMedia.mediaType;

      attachments.push(attachment);
    }

    const stdMessage: StdMessage = {
      id: waMessage.id._serialized,
      content: waMessage.body,
      platformAdapter: this,
      author: stdUser,
      timestamp: new Date(waMessage.timestamp * 1000),
      channelId: waMessage.from,
      threadId: waMessage.hasQuotedMsg
        ? (await waMessage.getQuotedMessage()).id._serialized
        : undefined,
      source: waMessage,
      platform: "whatsapp",
      isDirectMessage: async () => {
        const chat = await this.client.getChatById(waMessage.from);
        return !chat.isGroup; // Returns true if not a group chat
      },
      sendDirectMessage: async (recipientId, messageData) => {
        let media;
        if (messageData.file && "url" in messageData.file) {
          media = await MessageMedia.fromUrl(messageData.file.url);
        }
        if (messageData.file && "path" in messageData.file) {
          media = MessageMedia.fromFilePath(messageData.file.path);
        }
        await this.client.sendMessage(recipientId, messageData.content || "", {
          media,
        });
      },
      sendMessageToChannel: async (channelId, messageData) => {
        let media;
        if (messageData.file && "url" in messageData.file) {
          media = await MessageMedia.fromUrl(messageData.file.url);
        }
        if (messageData.file && "path" in messageData.file) {
          media = MessageMedia.fromFilePath(messageData.file.path);
        }
        await this.client.sendMessage(channelId, messageData.content || "", {
          media,
        });
      },
      sendFile: async (fileUrl, fileName) => {
        const media = MessageMedia.fromFilePath(fileUrl);
        await this.client.sendMessage(waMessage.from, media, {
          caption: fileName,
        });
      },
      fetchChannelMessages: async (limit: number) => {
        const chat = await this.client.getChatById(waMessage.from);
        const messages = await chat.fetchMessages({ limit });
        return Promise.all(messages.map((msg) => this.convertMessage(msg)));
      },
      getUserRoles: () => {
        const userConfig = userConfigs.find((user) =>
          user.identities.some(
            (identity) =>
              identity.platform === "whatsapp" &&
              identity.id === contact.id.user
          )
        );
        return userConfig ? userConfig.roles : ["user"];
      },
      send: async (messageData) => {
        let media;
        if (messageData.file && "url" in messageData.file) {
          media = await MessageMedia.fromUrl(messageData.file.url);
        }
        if (messageData.file && "path" in messageData.file) {
          media = MessageMedia.fromFilePath(messageData.file.path);
        }
        const sentMessage = await this.client.sendMessage(
          waMessage.from,
          messageData.content || "",
          {
            media,
          }
        );
        return this.convertSentMessage(sentMessage);
      },
      reply: async (messageData) => {
        let media;
        if (messageData.file && "url" in messageData.file) {
          media = await MessageMedia.fromUrl(messageData.file.url);
        }
        if (messageData.file && "path" in messageData.file) {
          media = MessageMedia.fromFilePath(messageData.file.path);
        }
        const sentMessage = await this.client.sendMessage(
          waMessage.from,
          messageData.content || "",
          {
            media,
          }
        );
        return this.convertSentMessage(sentMessage);
      },
      sendTyping: async () => {
        // WhatsApp Web API does not support sending typing indicators directly
        // You may leave this as a no-op
        const chat = await this.client.getChatById(waMessage.from)
        await chat.sendStateTyping()

      },
      attachments,
    };

    return stdMessage;
  }

  public async fetchMessageById(
    channelId: string,
    messageId: string
  ): Promise<StdMessage | null> {
    try {
      const waMessage = await this.client.getMessageById(messageId);
      if (waMessage) {
        const stdMessage = await this.convertMessage(waMessage);
        return stdMessage;
      } else {
        return null;
      }
    } catch (error) {
      console.error(`Failed to fetch message by ID: ${error}`);
      return null;
    }
  }

  private async convertSentMessage(
    sentWAMessage: WAMessage
  ): Promise<SentMessage> {
    const contact = await sentWAMessage.getContact();

    return {
      id: sentWAMessage.id._serialized,
      platformAdapter: this,
      content: sentWAMessage.body,
      author: {
        id: contact.id._serialized,
        username:
          contact.name ||
          contact.shortName ||
          contact.pushname ||
          contact.number,
        config: this.getUserById(contact.id._serialized),
      },
      timestamp: new Date(sentWAMessage.timestamp * 1000),
      channelId: sentWAMessage.from,
      threadId: sentWAMessage.hasQuotedMsg
        ? (await sentWAMessage.getQuotedMessage()).id._serialized
        : undefined,
      source: sentWAMessage,
      platform: "whatsapp",
      deletable: true,
      delete: async () => {
        await sentWAMessage.delete();
      },
      edit: async (messageData) => {
        sentWAMessage.edit(messageData.content || "");
      },
      reply: async (messageData) => {
        let media;
        if (messageData.file && "url" in messageData.file) {
          media = await MessageMedia.fromUrl(messageData.file.url);
        }
        if (messageData.file && "path" in messageData.file) {
          media = MessageMedia.fromFilePath(messageData.file.path);
        }
        const replyMessage = await sentWAMessage.reply(
          messageData.content || "",
          sentWAMessage.id._serialized,
          { media }
        );
        return this.convertSentMessage(replyMessage);
      },
      send: async (messageData) => {
        let media;
        if (messageData.file && "url" in messageData.file) {
          media = await MessageMedia.fromUrl(messageData.file.url);
        }
        if (messageData.file && "path" in messageData.file) {
          media = MessageMedia.fromFilePath(messageData.file.path);
        }
        const sentMessage = await this.client.sendMessage(
          sentWAMessage.from,
          messageData.content || "",
          {
            media,
          }
        );
        return this.convertSentMessage(sentMessage);
      },
      getUserRoles: () => {
        const userConfig = userConfigs.find((user) =>
          user.identities.some(
            (identity) =>
              identity.platform === "whatsapp" &&
              identity.id === contact.id._serialized
          )
        );
        return userConfig ? userConfig.roles : ["user"];
      },
      isDirectMessage: async () => {
        const chat = await this.client.getChatById(sentWAMessage.from);
        return !chat.isGroup; // Returns true if not a group chat
      },
      sendDirectMessage: async (recipientId, messageData) => {
        let media;
        if (messageData.file && "url" in messageData.file) {
          media = await MessageMedia.fromUrl(messageData.file.url);
        }
        if (messageData.file && "path" in messageData.file) {
          media = MessageMedia.fromFilePath(messageData.file.path);
        }
        await this.client.sendMessage(recipientId, messageData.content || "", {
          media,
        });
      },
      sendMessageToChannel: async (channelId, messageData) => {
        let media;
        if (messageData.file && "url" in messageData.file) {
          media = await MessageMedia.fromUrl(messageData.file.url);
        }
        if (messageData.file && "path" in messageData.file) {
          media = MessageMedia.fromFilePath(messageData.file.path);
        }
        await this.client.sendMessage(channelId, messageData.content || "", {
          media,
        });
      },
      sendFile: async (fileUrl, fileName) => {
        const media = MessageMedia.fromFilePath(fileUrl);
        await this.client.sendMessage(sentWAMessage.from, media, {
          caption: fileName,
        });
      },
      fetchChannelMessages: async (limit: number) => {
        const chat = await this.client.getChatById(sentWAMessage.from);
        const messages = await chat.fetchMessages({ limit });
        return Promise.all(messages.map((msg) => this.convertMessage(msg)));
      },
      sendTyping: async () => {
        // WhatsApp Web API does not support sending typing indicators directly
        // You may leave this as a no-op
        const chat = await this.client.getChatById(sentWAMessage.from)
        await chat.sendStateTyping()
      },
    };
  }
}
