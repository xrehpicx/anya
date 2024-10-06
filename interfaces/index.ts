import { MessageProcessor } from "../core/message-processor";
import { DiscordAdapter } from "./discord";
import { startEventsServer } from "./events";
import { Message } from "./message";
import { WhatsAppAdapter } from "./whatsapp";

// Initialize Discord Adapter and Processor
export const discordAdapter = new DiscordAdapter();

const discordProcessor = new MessageProcessor(discordAdapter);

// Initialize WhatsApp Adapter and Processor
export const whatsappAdapter = new WhatsAppAdapter();
const whatsappProcessor = new MessageProcessor(whatsappAdapter);

export function startInterfaces() {
  discordAdapter.onMessage(async (message) => {
    await discordProcessor.processMessage(message);
  });
  whatsappAdapter.onMessage(async (message) => {
    await whatsappProcessor.processMessage(message);
  });
  startEventsServer();
}

export async function getMessageInterface(identity: {
  platform: string;
  id: string;
}): Promise<Message> {
  try {
    switch (identity.platform) {
      case "discord":
        return await discordAdapter.createMessageInterface(identity.id);
      case "whatsapp":
        return await whatsappAdapter.createMessageInterface(identity.id);
      default:
        throw new Error(`Unsupported platform: ${identity.platform}`);
    }
  } catch (error) {
    throw new Error(`getMessageInterface error: ${(error as Error).message}`);
  }
}
