import {
  RunnableToolFunction,
  RunnableToolFunctionWithParse,
} from "openai/lib/RunnableFunction.mjs";
import { JSONSchema } from "openai/lib/jsonschema.mjs";
import { z, ZodSchema } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { evaluate } from "mathjs";

import {
  YoutubeDownloaderParams,
  YoutubeTranscriptParams,
  get_download_link,
  get_youtube_video_data,
} from "./youtube";
import {
  SendGeneralMessageParams,
  SendMessageParams,
  send_general_message,
  send_message_to,
} from "./messenger";
import {
  ChartParams,
  PythonCodeParams,
  RunPythonCommandParams,
  chart,
  code_interpreter,
  run_command_in_code_interpreter_env,
} from "./python-interpreter";
import { meme_maker, MemeMakerParams } from "./meme-maker";
import { getPeriodTools } from "./period";
import { linkManager, LinkManagerParams } from "./linkwarden";
import { search_chat, SearchChatParams } from "./chat-search";
import { getTotalCompletionTokensForModel } from "../usage";
import {
  scrape_and_convert_to_markdown,
  ScrapeAndConvertToMarkdownParams,
} from "./scrape";
import { calendarManager, CalendarManagerParams } from "./calender";
import { remindersManager, RemindersManagerParams } from "./reminders";
import { notesManager, NotesManagerParams, webdav_tools } from "./notes";
import { service_checker, ServiceCheckerParams } from "./status";
import {
  upload_file,
  UploadFileParams,
  get_file_list,
  GetFileListParams,
} from "./files";
// Removed import of createContextMessage since it's not used here
import { Message } from "../interfaces/message";
import { rolePermissions, userConfigs } from "../config"; // <-- Added import
import { search_user, SearchUserParams } from "./search-user";
import { ResendParams, send_email } from "./resend";
import { homeManager, HomeManagerParams } from "./home";
import { event_manager, EventManagerSchema } from "./events";
import { actionManager, ActionManagerParamsSchema } from "./actions";
import { search_whatsapp_contacts, SearchContactsParams } from "./whatsapp";
import { memory_manager_init } from "./memory-manager";
import { communication_manager_tool } from "./communication";
import { send_sys_log } from "../interfaces/log";
import { init_anya_todos_watcher, init_notes_watcher } from "./notes-executer";
import { initVectorStoreSync } from "./notes-vectors";
import {
  dockerToolManager,
  DockerToolManagerSchema,
} from "./software-engineer";
import { linear_manager_tool } from "./linear-manager";

// get time function
const GetTimeParams = z.object({});
type GetTimeParams = z.infer<typeof GetTimeParams>;
async function get_date_time({ }: GetTimeParams) {
  return { response: new Date().toLocaleString() };
}

// calculator function
const CalculatorParams = z.object({
  expression: z.string().describe("mathjs expression"),
});
type CalculatorParams = z.infer<typeof CalculatorParams>;
async function calculator({ expression }: CalculatorParams) {
  return { response: evaluate(expression) };
}

// run bash command function and return all output success/errors both
const RunBashCommandParams = z.object({
  command: z.string(),
});
type RunBashCommandParams = z.infer<typeof RunBashCommandParams>;
async function run_bash_command({ command }: RunBashCommandParams) {
  console.log("running command: " + command);
  const { exec } = await import("child_process");
  return (await new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      console.log("stdout: " + stdout);
      console.log("stderr: " + stderr);
      if (error !== null) {
        console.log("exec error: " + error);
      }
      resolve({ stdout, stderr, error });
    });
  })) as { stdout: string; stderr: string; error: any };
}

// exit process
const ExitProcessParams = z.object({});
type ExitProcessParams = z.infer<typeof ExitProcessParams>;
async function restart_self({ }: ExitProcessParams, context_message: Message) {
  await Promise.all([
    send_sys_log("Restarting myself"),
    context_message.send({
      content: "Restarting myself",
    }),
    context_message.send({
      content: "---setting this point as the start---",
    }),
  ]);
  return { response: process.exit(0) };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// get total tokens used by a model
const GetTotalTokensParams = z.object({
  model: z.string(),
  from: z.string(),
  to: z.string(),
});

type GetTotalTokensParams = z.infer<typeof GetTotalTokensParams>;

async function get_total_tokens({ model, from, to }: GetTotalTokensParams) {
  return {
    response: getTotalCompletionTokensForModel(model, from, to),
  };
}

init_notes_watcher();
init_anya_todos_watcher();
initVectorStoreSync();

export function getTools(
  username: string,
  context_message: Message,
  manager_id?: string
) {
  const userRoles = context_message.getUserRoles();

  console.log("User roles: ", userRoles);

  // Aggregate permissions from all roles
  const userPermissions = new Set<string>();
  userRoles.forEach((role) => {
    const permissions = rolePermissions[role];
    if (permissions) {
      permissions.forEach((perm) => userPermissions.add(perm));
    }
  });

  // Helper function to check if the user has access to a tool
  function hasAccess(toolName: string): boolean {
    if (toolName === "periodTools") {
      return userPermissions.has("periodUser");
    }
    return userPermissions.has("*") || userPermissions.has(toolName);
  }

  // Define all tools with their names
  const allTools: {
    name: string;
    tool: RunnableToolFunction<any> | RunnableToolFunction<any>[];
  }[] = [
      {
        name: "calculator",
        tool: zodFunction({
          function: calculator,
          schema: CalculatorParams,
          description: "Evaluate math expression",
        }),
      },
      {
        name: "getTime",
        tool: zodFunction({
          function: get_date_time,
          schema: GetTimeParams,
          description: "Get current date and time",
        }),
      },
      {
        name: "search_user_ids",
        tool: zodFunction({
          function: (args) => search_user(args, context_message),
          name: "search_user_ids",
          schema: SearchUserParams,
          description: `Search and get user's details. Use this only when required.`,
        }),
      },

      // Computer nerd tools

      // {
      //   name: "search_whatsapp_contacts",
      //   tool: zodFunction({
      //     function: search_whatsapp_contacts,
      //     schema: SearchContactsParams,
      //     description: `Search for contacts in user's whatsapp account. Use this to get whatsapp user_id of any user.
      //     Note: Confirm from the user before sending any messages to the contacts found using this search.
      //     `,
      //   }),
      // },
      /* {
        name: "scrapeWeb",
        tool: zodFunction({
          function: scrape_and_convert_to_markdown,
          schema: ScrapeAndConvertToMarkdownParams,
          name: "scrape_web",
          description: `Get data from a webpage.`,
        }),
      },
      {
        name: "uploadFile",
        tool: zodFunction({
          function: upload_file,
          schema: UploadFileParams,
          description: `Upload a LOCAL file to a MinIO bucket and return its public URL.
  
  Note:
  - The filePath should be a local file path in the /tmp directory.
  - If you want to re-upload a file from the internet, you can download it using run_shell_command to a /tmp directory and then upload it.
  
  Use cases:
  - You can use this to share files from inside the code interpreter using the /tmp file path.
  - You can use this to share files that only you have access to, like temporary files or discord files.
  - You can use this when the user explicitly asks for a file to be shared with them or wants to download a file.`,
        }),
      },
      {
        name: "getFileList",
        tool: zodFunction({
          function: get_file_list,
          schema: GetFileListParams,
          description: `Get the list of public URLs for all files in the MinIO bucket`,
        }),
      },
      {
        name: "getYouTubeVideoData",
        tool: zodFunction({
          function: get_youtube_video_data,
          schema: YoutubeTranscriptParams as any,
          description:
            "Get YouTube video data. Use this only when sent a YouTube URL. Do not use this for YouTube search.",
        }),
      },
      {
        name: "getDownloadLink",
        tool: zodFunction({
          function: get_download_link as any,
          schema: YoutubeDownloaderParams,
          description: `Get download link for YouTube links.
  Also, always hide the length of links that are too long by formatting them with markdown.
  For any site other than YouTube, use code interpreter to scrape the download link.
  
  If the user wants the file and not just the link:
  You can use the direct link you get from this to download the media inside code interpreter and then share the downloaded files using the send message tool.
  Make sure that the file size is within discord limits.`,
        }),
      },
      {
        name: "codeInterpreter",
        tool: zodFunction({
          function: (args) => code_interpreter(args, context_message),
          name: "code_interpreter",
          schema: PythonCodeParams,
          description: `Primary Function: Run Python code in an isolated environment.
  Key Libraries: pandas for data analysis, matplotlib for visualization.
  Use Cases: Data analysis, plotting, image/video processing using ffmpeg for video, complex calculations, and attachment analysis.
  You can also use this to try to scrape and get download links from non-YouTube sites.
  
  File sharing:
  To share a file with a user from inside code interpreter, you can save the file to the /tmp/ directory and then use the send message tool to send the file to the user by using the full path of the file, including the /tmp part in the path.
  
  Notes:
  Import necessary libraries; retry if issues arise.
  For web scraping, process data to stay within a 10,000 token limit.
  Use run_shell_command to check or install dependencies.
  Try to fix any errors that are returned at least once before sending to the user, especially syntax/type errors.`,
        }),
      },
      {
        name: "runShellCommand",
        tool: zodFunction({
          function: (args) =>
            run_command_in_code_interpreter_env(args, context_message),
          name: "run_shell_command",
          schema: RunPythonCommandParams,
          description: `Run bash command. Use this to install any needed dependencies.`,
        }),
      }, */

      //     {
      //       name: "generateChart",
      //       tool: zodFunction({
      //         function: chart,
      //         name: "generate_chart",
      //         schema: ChartParams,
      //         description: `Generate chart PNG image URL using quickchart.io`,
      //       }),
      //     },
      //     {
      //       name: "memeOrCatMaker",
      //       tool: zodFunction({
      //         function: meme_maker,
      //         name: "meme_or_cat_maker",
      //         schema: MemeMakerParams,
      //         description: `Generate meme image URL using memegen.link OR generate cat image URL using cataas.com

      // Just provide the info in the query, and it will generate the URL for you.
      // This can include any memegen.link or cataas.com specific parameters.
      // Make sure to give as many details as you can about what the user wants.
      // Also, make sure to send the images and memes as files to the user using the send message tool unless explicitly asked to send the URL.`,
      //       }),
      //     },
      //     {
      //       name: "sendMessageToChannel",
      //       tool: zodFunction({
      //         function: (args) => send_general_message(args, context_message),
      //         name: "send_message_to_channel",
      //         schema: SendGeneralMessageParams,
      //         description: `Send message to the current Discord channel.
      // You can also use this for reminders or other scheduled messages by calculating the delay from the current time.
      // If the user does not specify a time for a reminder, think of one based on the task.
      // If no channel ID is provided, the message will be sent to the user you are currently chatting with.`,
      //       }),
      //     },
      //     {
      //       name: "searchChat",
      //       tool: zodFunction({
      //         function: (args) => search_chat(args, context_message),
      //         name: "search_chat",
      //         schema: SearchChatParams,
      //         description: `Search for messages in the current channel based on query parameters.
      // This will search the last 100 (configurable by setting the limit parameter) messages in the channel.
      // Set user_only parameter to true if you want to search only the user's messages.`,
      //       }),
      //     },
      {
        name: "serviceChecker",
        tool: zodFunction({
          function: service_checker,
          name: "service_checker",
          schema: ServiceCheckerParams,
          description: `Check the status of a service by querying the status page of the service. Use this when the user asks if something is up or down in the context of a service.`,
        }),
      },
      //     {
      //       name: "getTotalTokens",
      //       tool: zodFunction({
      //         function: get_total_tokens,
      //         name: "get_total_tokens",
      //         schema: GetTotalTokensParams,
      //         description: `Get total tokens used by a model in a date range

      // The pricing as of 2024 is:
      // gpt-4o:
      // $5.00 / 1M prompt tokens
      // $15.00 / 1M completion tokens

      // gpt-4o-mini:
      // $0.150 / 1M prompt tokens
      // $0.600 / 1M completion tokens

      // Use calculator to make the math calculations.`,
      //       }),
      //     },
      {
        name: "communicationsManagerTool",
        tool: communication_manager_tool(context_message),
      },
      {
        name: "calendarManagerTool",
        tool: zodFunction({
          function: (args) => calendarManager(args, context_message),
          name: "calendar_manager",
          schema: CalendarManagerParams,
          description: `Manage calendar events using user's Calendar.
        You can just forward the user's request to this tool and it will handle the rest.`,
        }),
      },
      {
        name: "remindersManagerTools",
        tool: zodFunction({
          function: (args) => remindersManager(args, context_message),
          name: "reminders_manager",
          schema: RemindersManagerParams,
          description: `Manage reminders using user's reminders.
        You can just forward the user's request to this tool and it will handle the rest.
        
        More detailed todos that dont need user notification will be managed by the notes manager tool instead.
        `,
        }),
      },
      {
        name: "homeAssistantManagerTool",
        tool: zodFunction({
          function: (args) => homeManager(args, context_message),
          name: "home_assistant_manager",
          schema: HomeManagerParams,
          description: `Manage home assistant devices and services in natural language.
        Give as much details as possible to get the best results.
        Especially what devices that the user named and what action they want to perform on them.
        `,
        }),
      },
      {
        name: "notesManagerTool",
        tool: zodFunction({
          function: (args) => notesManager(args, context_message),
          name: "notes_manager",
          schema: NotesManagerParams,
          description: `Manage notes using user's notes.
        
        You can just forward the user's request verbatim (or by adding more clarity) to this tool and it will handle the rest.
        
        When to use: 
        if user talks about any notes, lists, journal, gym entry, standup, personal journal, etc.
        You can also use this for advanced todos that are more planning related. (these are not reminders, and will not notify the user)
        `,
        }),
      },
      {
        name: "linkManagerTool",
        tool: zodFunction({
          function: (args) => linkManager(args, context_message),
          name: "link_manager",
          schema: LinkManagerParams,
          description: `Manage links using LinkWarden.
        You can just forward the user's request to this tool and it will handle the rest.
        `,
        }),
      },
      {
        name: "ProjectManager",
        tool: linear_manager_tool(context_message),
      },
      {
        name: "actionsManagerTool",
        tool: zodFunction({
          function: (args) => actionManager(args, context_message),
          name: "actions_manager",
          schema: ActionManagerParamsSchema,
          description: `Manage scheduled actions using the Actions Manager.
    
        Forward user requests to create, update, retrieve, or remove actions.

        You can use this for when a user wants you to do something at a specific time or after a specific time.`,
        }),
      },
      {
        name: "eventsManagerTool",
        tool: zodFunction({
          function: (args) => event_manager(args, context_message),
          name: "events_manager",
          schema: EventManagerSchema,
          description: `Manage events using the Events Manager.

        Forward user requests to create, update, retrieve, or remove events.

        When to use:
        if user wants to create some automation based on some event.`,
        }),
      },
      {
        name: "softwareEngineerManagerTool",
        tool: zodFunction({
          function: (args) => dockerToolManager(args, context_message),
          name: "software_engineer_manager",
          schema: DockerToolManagerSchema,
          description: `Software Engineer Manager Tool.
His name is Cody. He is a software engineer, and someone who loves technology.
He specializes in linux and devops.

This tool can do anything related to what a tech person would do.
They can scape website to search something, summerize youtube videos by just link, download full videos and more.
This manager is like a whole other user that you are talking to.

When talking to this manager, you can inform the user that you asked cody for this query etc.
        `,
        }),
      },
      {
        name: "restart",
        tool: zodFunction({
          function: (args) => restart_self(args, context_message),
          name: "restart_self",
          schema: ExitProcessParams,
          description:
            "Restart yourself. do this only when the user explicitly asks you to restart yourself.",
        }),
      },
      // {
      //   name: "eventTools",
      //   tool: event_tools(context_message),
      // },
      // Period tools
      {
        name: "periodTools",
        tool: getPeriodTools(context_message),
      },
    ];

  const manager_tools = manager_id
    ? [memory_manager_init(context_message, manager_id)]
    : [];

  // Filter tools based on user permissions
  const tools = allTools
    .filter(({ name }) => hasAccess(name))
    .flatMap(({ tool }) => (Array.isArray(tool) ? tool : [tool]))
    .concat(manager_tools);

  return tools;
}

export function zodFunction<T extends object>({
  function: fn,
  schema,
  description = "",
  name,
}: {
  function: (args: T) => Promise<object> | object;
  schema: ZodSchema<T>;
  description?: string;
  name?: string;
}): RunnableToolFunctionWithParse<T> {
  return {
    type: "function",
    function: {
      function: fn,
      name: name ?? fn.name,
      description: description,
      parameters: zodToJsonSchema(schema) as JSONSchema,
      parse(input: string): T {
        const obj = JSON.parse(input);
        return schema.parse(obj);
      },
    },
  };
}
