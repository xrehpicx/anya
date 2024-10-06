import { discordAdapter } from ".";

export function send_sys_log(content: string) {
  return discordAdapter.sendSystemLog(content);
}
