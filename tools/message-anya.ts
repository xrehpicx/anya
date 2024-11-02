import { z } from "zod";
import { zodFunction } from ".";
import { eventManager } from "../interfaces/events";

const MessageAnyaSchema = z.object({
  message: z.string(),
});
export type MessageAnyaSchema = z.infer<typeof MessageAnyaSchema>;

async function message_anya({ message }: MessageAnyaSchema, event_id: string) {
  const res = await eventManager.emitWithResponse(event_id, {
    message,
  });
  return JSON.stringify(res);
}
export const message_anya_tool = (event_id: string) =>
  zodFunction({
    function: async (args: MessageAnyaSchema) =>
      await message_anya(args, event_id),
    name: "message_anya",
    schema: MessageAnyaSchema,
    description: "Send a message to Anya.",
  });
