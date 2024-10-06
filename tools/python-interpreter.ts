// tools/python-interpreter.ts

import { nanoid } from "nanoid";
import fs from "fs";
import os from "os";
import path from "path";
import { exec } from "child_process";
import { z } from "zod";
import { Message } from "../interfaces/message";
import QuickChart from "quickchart-js";
import { $ } from "zx";

// Utility function to run Python code in an existing Docker container
async function runPythonCodeInExistingDocker(
  pythonCode: string,
  dependencies: string[] = [],
  uid: string
) {
  const containerName = `python-runner-${uid}`;

  // Check if container exists; if not, create it
  const op =
    await $`docker ps -a --filter "name=${containerName}" --format "{{.Names}}"`;
  if (op.stdout.trim() === containerName) {
    console.log("Container exists");
  } else {
    console.log("Container does not exist, creating it");
    await $`docker run -d --name ${containerName} -v /tmp:/tmp python:3.10 tail -f /dev/null`;
  }

  return await new Promise((resolve, reject) => {
    const tempFileName = `tempScript-${nanoid()}.py`;
    const tempFilePath = path.join(os.tmpdir(), tempFileName);

    fs.writeFile(tempFilePath, pythonCode, (err) => {
      if (err) {
        console.error(`Error writing Python script to file: ${err}`);
        reject(`Error writing Python script to file: ${err}`);
        return;
      }

      const dockerCommand = `docker exec ${containerName} python /tmp/${tempFileName}`;

      console.log("Executing Docker command:", dockerCommand);

      exec(dockerCommand, (error, stdout, stderr) => {
        setTimeout(() => {
          fs.unlink(tempFilePath, (unlinkErr) => {
            if (unlinkErr) {
              console.error(`Error deleting temporary file: ${unlinkErr}`);
            }
          });
        }, 60000);

        if (error) {
          console.error(`Error executing Python script: ${error}`);
          reject(`${error}\nTry to fix the above error`);
          return;
        }
        if (stderr) {
          console.error(`stderr: ${stderr}`);
        }
        console.log("Python script executed successfully.", stdout);
        resolve(stdout);
      });
    });
  });
}

// Python code interpreter
export const PythonCodeParams = z.object({
  code: z.string().describe("The Python 3.10 code to run"),
});
export type PythonCodeParams = z.infer<typeof PythonCodeParams>;

export async function code_interpreter(
  { code }: PythonCodeParams,
  context_message: Message
) {
  try {
    const output = await runPythonCodeInExistingDocker(
      code,
      [],
      context_message.id
    );
    return { output };
  } catch (error) {
    return { error };
  }
}

// Run bash command in the above Docker container
export const RunPythonCommandParams = z.object({
  command: z.string().describe("The command to run"),
});
export type RunPythonCommandParams = z.infer<typeof RunPythonCommandParams>;

export async function run_command_in_code_interpreter_env(
  { command }: RunPythonCommandParams,
  context_message: Message
): Promise<object> {
  const containerName = `python-runner-${context_message.id}`;

  // Check if container exists; if not, create it
  const op =
    await $`docker ps -a --filter "name=${containerName}" --format "{{.Names}}"`;
  if (op.stdout.trim() === containerName) {
    console.log("Container exists");
  } else {
    console.log("Container does not exist, creating it");
    await $`docker run -d --name ${containerName} -v /tmp:/tmp python:3.10 tail -f /dev/null`;
  }

  const dockerCommand = `docker exec ${containerName} ${command}`;

  console.log("Executing Docker command:", dockerCommand);

  return await new Promise((resolve, reject) => {
    exec(dockerCommand, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error executing command: ${error}`);
        reject({
          error: `Error executing command: ${error}`,
        });
        return;
      }
      if (stderr) {
        console.error(`stderr: ${stderr}`);
      }
      console.log("Command executed successfully.");
      resolve({ output: stdout });
    });
  });
}

// Generate chart image URL using quickchart.io
export const ChartParams = z.object({
  chart_config: z.object({
    type: z.string().optional(),
    data: z.object({
      labels: z.array(z.string()).optional(),
      datasets: z.array(
        z.object({
          label: z.string().optional(),
          data: z.array(z.number()).optional(),
          backgroundColor: z.string().optional(),
          borderColor: z.string().optional(),
          borderWidth: z.number().optional(),
        })
      ),
    }),
    options: z.object({
      title: z.object({
        display: z.boolean().optional(),
        text: z.string().optional(),
      }),
    }),
  }),
});
export type ChartParams = z.infer<typeof ChartParams>;

export async function chart({ chart_config }: ChartParams) {
  try {
    const myChart = new QuickChart();
    myChart.setConfig(chart_config);
    const chart_url = await myChart.getShortUrl();
    return { chart_url };
  } catch (error) {
    return { error };
  }
}

// Send file to user
export const SendFileParams = z.object({
  file_url: z
    .string()
    .describe(
      "File URL. This can be a web URL or a direct file path from code interpreter '/tmp/file.png'. Try checking if the file exists before sending it."
    ),
  file_name: z.string().describe("File name, use .png for images"),
});
export type SendFileParams = z.infer<typeof SendFileParams>;

export async function send_file(
  { file_url, file_name }: SendFileParams,
  context_message: Message
) {
  try {
    await context_message.sendFile(file_url, file_name);
    return { response: "File sent" };
  } catch (error) {
    return { error };
  }
}
