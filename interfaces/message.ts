import { UserConfig } from "../config";
import { PlatformAdapter } from "./platform-adapter";

export interface User {
  id: string;
  username: string;
  config?: UserConfig | null;
  meta?: any;
}

export interface SentMessage extends Message {
  deletable: boolean;
  delete: () => Promise<void>;
  edit: (data: any) => Promise<void>;
}

export interface Attachment {
  url: string;
  contentType?: string;
  data?: Buffer | string;
  type?: string;
}

export interface Embed {
  [key: string]: any;
}

export interface MessageData {
  content?: string;
  embeds?: Embed[];
  options?: any;
  flags?: any;
  file?:
    | {
        url: string;
      }
    | { path: string };
}

export interface Message {
  id: string;
  content: string;
  author: User;
  timestamp: Date;
  channelId: string;
  threadId?: string;
  attachments?: Attachment[];
  embeds?: Embed[];
  source: any; // Original message object (from Discord or WhatsApp)
  platform: "discord" | "whatsapp" | "other";
  reply: (data: MessageData) => Promise<SentMessage>;
  send: (data: MessageData) => Promise<SentMessage>;
  getUserRoles: () => string[];
  isDirectMessage: () => Promise<boolean>;
  sendDirectMessage: (
    userId: string,
    messageData: MessageData
  ) => Promise<void>;
  sendMessageToChannel: (
    channelId: string,
    messageData: MessageData
  ) => Promise<void>;
  sendFile: (fileUrl: string, fileName: string) => Promise<void>;
  fetchChannelMessages: (limit: number) => Promise<Message[]>;
  sendTyping: () => Promise<void>;
  platformAdapter: PlatformAdapter;
}
