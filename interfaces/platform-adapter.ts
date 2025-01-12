import { UserConfig } from "../config";
import { Attachment, Message, User } from "./message";

export interface FetchOptions {
  limit?: number;
  before?: string;
  after?: string;
}

export interface PlatformAdapter {
  onMessage(callback: (message: Message) => void): void;
  sendMessage(channelId: string, content: string): Promise<void>;
  fetchMessages(channelId: string, options: FetchOptions): Promise<Message[]>;
  fetchMessageById(
    channelId: string,
    messageId: string
  ): Promise<Message | null>;
  getBotId(): string; // For identifying bot's own messages
  getUserById(userId: string): UserConfig | null;
  sendSystemLog?(content: string): Promise<void>;
  searchUser(query: string): Promise<User[]>;
  config: {
    indicators: {
      typing: boolean;
      processing: boolean;
    };
  };
  handleMediaAttachment?(attachment: Attachment): Promise<{
    base64?: string;
    transcription?: string;
    mediaType: 'image' | 'audio' | 'other';
  }>;
}
