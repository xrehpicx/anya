import { Message } from "discord.js";
import { z } from "zod";

// get time function
const GetTimeParams = z.object({});
type GetTimeParams = z.infer<typeof GetTimeParams>;
async function get_time({}: GetTimeParams) {
  return { time: new Date().toLocaleTimeString() };
}

// schedule a message to be sent in the future
export const ScheduleMessageParams = z.object({
  message: z.string(),
  delay: z.number().describe("delay in milliseconds"),
});
export type ScheduleMessageParams = z.infer<typeof ScheduleMessageParams>;
export async function schedule_message(
  { message, delay }: ScheduleMessageParams,
  context_message: Message<boolean>
) {
  setTimeout(() => {
    context_message.channel.send(message);
  }, delay);
  return { response: "scheduled message" };
}
