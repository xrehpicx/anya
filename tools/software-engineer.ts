import { z } from "zod";
import { $ } from "zx";
import { zodFunction } from "./";
import { Message } from "../interfaces/message";
import { ask } from "./ask";
import { ChatCompletion } from "openai/resources/index.mjs";
import { eventManager } from "../interfaces/events";

// Schema for Docker Tool Manager input
export const DockerToolManagerSchema = z.object({
  message: z.string(),
  wait_for_reply: z
    .boolean()
    .optional()
    .describe(
      "Wait for a reply from cody. if false or not defined cody will do the task in the background. Defaults to true"
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
}: RunCommandParams): Promise<unknown> {
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
      return {
        results: {
          error: createError.stderr || createError.message,
          message: "Error creating container",
        },
      };
    }
  }

  if (!wait) {
    // Return early if not waiting for command to finish
    const results = { results: "Command started" };
    return {
      results,
    };
  }

  // Step 2: Execute commands sequentially
  const results = new Map<
    string,
    { success: boolean; output?: string; error?: string }
  >();

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    console.log(
      `Executing Docker command: docker exec ${containerName} /bin/bash -c "${command}"`
    );

    try {
      const processOutput =
        await $`docker exec ${containerName} /bin/bash -c ${command}`;
      console.log(`Command executed successfully: ${command}`);
      results.set(command, {
        success: true,
        output: stdout ? processOutput.stdout : undefined,
      });
    } catch (runError: any) {
      console.error(
        `Error during command execution at command index ${i}: ${
          runError.stderr || runError.message
        }`
      );
      results.set(command, {
        success: false,
        error: stderr ? runError.stderr || runError.message : undefined,
      });
    }
  }

  // All commands executed
  const resultsOb = Object.fromEntries(results);
  console.log("All commands executed.", resultsOb);
  return { results: resultsOb };
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
  { message, wait_for_reply = true }: DockerToolManager,
  context_message: Message
): Promise<{ response: string }> {
  console.log("Docker Tool Manager invoked with message:", message);

  const toolsPrompt = `# You are Cody.

You are a software engineer, and someone who loves technology.

You specialize in linux and devops, and a python expert.

You also love to read markdown files to know more about why some files are the way they are.

With the above expertise, you can do almost anything.

Your home directory which has all your data is the /anya directory.

This is your home your desktop and your playground to maintain and manage your tools and yourself.

Each directory inside /anya and /anya itself has its purpose defined in the readme.md file in its root.

Rules when interacting with /anya:
1. Make sure to follow the instructions in the readme.md file in the root of the directory that you are trying to interact with.
2. Make sure you remember that your commands are run in a docker container using the docker exec command, which means your session is not persistent between commands. So generate your commands accordingly.
3. Any doubts you can try to figure out based on the markdown doc files you have access to, and if still not clear, you can ask user for more information.

Use the above to help the user with their request.

Current files in /anya are:
\`\`\`
${await $`ls -l /anya`}
\`\`\`

Current file structure in /anya is:
\`\`\`
${await $`tree /anya -L 2`}
\`\`\
`;

  // Load tools for memory manager and Docker command execution
  const tools = [run_command_tool.tool];

  let response: ChatCompletion;

  const promise = ask({
    model: "gpt-4o",
    prompt: `${toolsPrompt}`,
    tools: tools,
    message: message,
    seed: `cody-docker-tool-manager-${context_message.author.id}`,
  });

  if (!wait_for_reply) {
    const timestamp = new Date().toTimeString();
    setTimeout(async () => {
      const startTime = Date.now();
      try {
        response = await promise;
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
    response = await promise;
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
