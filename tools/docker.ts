import { z } from "zod";

// run bash command in docker container
export const RunCommandParams = z.object({
  command: z.string().describe("the command to run"),
});
export type RunCommandParams = z.infer<typeof RunCommandParams>;
export async function run_command({ command }: RunCommandParams) {
  const { exec } = require("child_process");
  return new Promise((resolve, reject) => {
    exec(command, (error: any, stdout: any, stderr: any) => {
      if (error) {
        console.log(`error: ${error.message}`);
        reject(error.message);
      }
      if (stderr) {
        console.log(`stderr: ${stderr}`);
        reject(stderr);
      }
      console.log(`stdout: ${stdout}`);
      resolve(stdout);
    });
  });
}
