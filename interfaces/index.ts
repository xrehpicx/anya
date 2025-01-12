import { MessageProcessor } from "../core/message-processor";
import { DiscordAdapter } from "./discord";
import { startEventsServer } from "./events";
import { Message } from "./message";
import { WhatsAppAdapter } from "./whatsapp";

// Add debounce utility function
function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait) as any;
  };
}

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

  // Debounce WhatsApp messages with 500ms delay
  const debouncedWhatsAppProcessor = debounce(async (message) => {
    await whatsappProcessor.processMessage(message);
  }, 1000);

  whatsappAdapter.onMessage(debouncedWhatsAppProcessor);
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
