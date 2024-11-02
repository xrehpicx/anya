import { z } from "zod";
import { $ } from "zx";
import { zodFunction } from "./";
import { Message } from "../interfaces/message";
import { ask } from "./ask";
import { memory_manager_init, memory_manager_guide } from "./memory-manager";
import { ChatCompletion } from "openai/resources/index.mjs";
import { eventManager } from "../interfaces/events";

// Schema for Docker Tool Manager input
export const DockerToolManagerSchema = z.object({
  message: z.string(),
  wait_for_reply: z
    .boolean()
    .optional()
    .describe(
      "Wait for a reply from cody. if false or not defined cody will do the task in the background."
    ),
});

export type DockerToolManager = z.infer<typeof DockerToolManagerSchema>;

// Schema for running commands on the Docker container
export const RunCommandParams = z.object({
  commands: z
    .array(z.string())
    .describe("An array of commands to run in the Docker container"),
  wait: z
    .boolean()
    .optional()
    .describe(
      "Wait for the command to finish before proceeding. defaults to true."
    ),
  stdout: z
    .boolean()
    .optional()
    .describe(
      "Weather to return the output of the command. defaults to true. You can make this false for cases where you dont want to return the output of the command, example updating env or installing packages."
    ),
  stderr: z
    .boolean()
    .optional()
    .describe("Weather to return the error of the command. defaults to true."),
});
export type RunCommandParams = z.infer<typeof RunCommandParams>;

const containerName = "anya-manager-container";
export async function run_command({
  commands,
  wait = true,
  stderr = true,
  stdout = true,
}: RunCommandParams): Promise<{
  stdout?: string;
  error?: string;
  failedCommand?: string;
}> {
  // Step 1: Check if the container exists and is running
  try {
    const isRunning =
      await $`docker inspect -f '{{.State.Running}}' ${containerName}`;
    if (isRunning.stdout.trim() !== "true") {
      console.log(`Container ${containerName} is not running. Starting it...`);
      await $`docker start ${containerName}`;
    }
  } catch (checkError) {
    console.log(`Container ${containerName} does not exist. Creating it...`);
    try {
      // Create a new always-running Ubuntu container with /anya mounted
      await $`docker run -d --name anya-manager-container --restart always -v /anya:/anya python:3.10 /bin/bash -c "while true; do sleep 3600; done"`;
    } catch (createError: any) {
      console.error(
        `Error creating container ${containerName}: ${
          createError.stderr || createError.message
        }`
      );
      return { error: createError.stderr || createError.message };
    }
  }

  if (!wait) {
    // Return early if not waiting for command to finish
    return { stdout: "Command execution started in the background." };
  }

  // Step 2: Execute commands sequentially
  let combinedStdout = "";
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    console.log(
      `Executing Docker command: docker exec ${containerName} /bin/bash -c "${command}"`
    );

    try {
      const processOutput =
        await $`docker exec ${containerName} /bin/bash -c ${command}`;
      console.log(`Command executed successfully: ${command}`);
      if (stdout) {
        combinedStdout += processOutput.stdout;
      }
    } catch (runError: any) {
      console.error(
        `Error during command execution at command index ${i}: ${
          runError.stderr || runError.message
        }`
      );
      if (stderr) {
        return {
          error: runError.stderr || runError.message,
          failedCommand: command,
        };
      }
    }
  }

  // All commands executed successfully
  console.log("All commands executed successfully.");
  return { stdout: combinedStdout || "All commands executed successfully." };
}

// Tool definition for running commands in the Docker container
export const run_command_tool = {
  name: "runCommand",
  tool: zodFunction({
    function: async (args: RunCommandParams) => await run_command(args),
    name: "run_command",
    schema: RunCommandParams,
    description:
      "Run commands in the manager's Docker container with a description of their purpose.",
  }),
};

// Main Docker Tool Manager function
export async function dockerToolManager(
  { message, wait_for_reply }: DockerToolManager,
  context_message: Message
): Promise<{ response: string }> {
  console.log("Docker Tool Manager invoked with message:", message);
  const toolsPrompt = `# You are Cody.

You are a software engineer, and someone who loves technology.

You specialize in linux and devops, and a python expert.

You exist inside a docker container named '${containerName}'.

The current time is: ${new Date().toLocaleString()}.

## Responsibilities:
1. You have access to a docker container of image python version 3.10 (based on Debian) that you can run commands on.
2. You can install software, update configurations, or run scripts in the environment.
3. You can presonalise the environment to your liking.
4. Help the user when they ask you for something to be done.

### Container details:
- The container is always running.
- The container has a volume mounted at /anya which persists data across container restarts.
- /anya is the only directory accessible to the user.

## The /anya/readme.md file

1. You can use the file at /anya/readme.md to keep track of all the changes you make to the environment.

2. These changes can include installing new software, updating configurations, or running scripts.

3. This file can also contain any account credentials or API keys that you saved with some description so that you know what they are for.

4. It is important that you keep /anya/readme.md updated as to not repeat yourself, the /anya/readme.md acts as your memory.

The current data from /anya/readme.md is:
\`\`\`
${await $`cat /anya/readme.md`}
\`\`\`

You can also use /anya/memories/ directory to store even more specific information incase the /anya/readme.md file gets too big.

Current /anya/memories/ directory contents (tree /anya/memories/ command output):
\`\`\`
${await $`tree /anya/memories/`}
\`\`\`

You can also save scripts in /anya/scripts/ directory and run them when needed.

Current /anya/scripts/ directory contents (ls /anya/scripts/ command output):
\`\`\`
${await $`ls /anya/scripts/`}
\`\`\`
This directory can contain both python or any language script based on your preference.

When you create a script in /anya/scripts/ directory you also should create a similarly named file prefixed with instruction_ that explains how to run the script.

This will help you run older scripts.

You can also keep all your python dependencies in a virtual env inside /anya/scripts/venv/ directory.

You can also use the /anya/media/ dir to store media files, You can arrange them in sub folders you create as needed.

Current /anya/media/ directory contents (ls /anya/media/ command output):
\`\`\`
${await $`ls /anya/media/`}
\`\`\`


Example flow:
User: plz let me download this youtube video https://youtube.com/video
What you need to do:
1. Look at the /anya/scripts/ data if there is a script to download youtube videos.
2. If there is no script, create a new script to download youtube videos while taking the param as the youtube url and the output file path and save it in /anya/scripts/ directory and also create a instruction_download_youtube_video.md file.
3. look at the instruction_download_youtube_video.md file to see how to run that script.
4. Run the script with relavent params.
5. Update the /anya/readme.md file with the changes you had to make to the environment like installing dependencies or creating new scripts.
6. Reply with the file path of the youtube video, and anything else you want.

You can also leave notes for yourself in the same file for future reference of changes you make to your environment.
`;

  // Load tools for memory manager and Docker command execution
  const tools = [run_command_tool.tool];

  let response: ChatCompletion;

  if (!wait_for_reply) {
    const timestamp = new Date().toTimeString();
    setTimeout(async () => {
      const startTime = Date.now();
      try {
        response = await ask({
          model: "gpt-4o",
          prompt: `${toolsPrompt}`,
          tools: tools,
          message: message,
        });
      } catch (error: any) {
        console.error(`Error during ask function: ${error.message}`);
        return { response: `An error occurred: ${error.message}` };
      }
      const endTime = Date.now();
      const executionTime = endTime - startTime;
      console.log(`Execution time: ${executionTime}ms`);

      eventManager.emit("message_from_cody", {
        users_request: message,
        users_request_timestamp: timestamp,
        codys_response: response.choices[0].message.content || "NULL",
        execution_time: `${executionTime}ms`,
      });
    }, 0);

    return {
      response:
        "Cody will take care of your request in the background and ping you later through an event.",
    };
  }

  try {
    response = await ask({
      model: "gpt-4o",
      prompt: toolsPrompt,
      tools: tools,
      message: message,
    });
  } catch (error: any) {
    console.error(`Error during ask function: ${error.message}`);
    return { response: `An error occurred: ${error.message}` };
  }

  console.log("Docker Tool Manager response:", response);
  return { response: response.choices[0].message.content || "NULL" };
}

// Tool definition for the Docker Tool Manager
export const docker_tool_manager_tool = (context_message: Message) =>
  zodFunction({
    function: async (args: DockerToolManager) =>
      await dockerToolManager(args, context_message),
    name: "docker_tool_manager",
    schema: DockerToolManagerSchema,
    description: `Docker Tool Manager: Manages a Docker container for command execution, utilizing memory for tracking and retrieving past executions.`,
  });
