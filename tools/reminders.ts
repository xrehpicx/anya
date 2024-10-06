import axios, { AxiosError } from "axios";
import { z } from "zod";
import { zodFunction } from ".";
import { RunnableToolFunction } from "openai/lib/RunnableFunction.mjs";
import { ask } from "./ask";
import { Message } from "../interfaces/message";
import { memory_manager_guide, memory_manager_init } from "./memory-manager";

const NEXTCLOUD_API_ENDPOINT =
  "http://192.168.29.85/remote.php/dav/calendars/raj/";
const NEXTCLOUD_USERNAME = process.env.NEXTCLOUD_USERNAME;
const NEXTCLOUD_PASSWORD = process.env.NEXTCLOUD_PASSWORD;

if (!NEXTCLOUD_USERNAME || !NEXTCLOUD_PASSWORD) {
  throw new Error(
    "Please provide NEXTCLOUD_USERNAME and NEXTCLOUD_PASSWORD environment variables."
  );
}

const TASKS_CALENDAR_NAME = "anya";

const apiClient = axios.create({
  baseURL: NEXTCLOUD_API_ENDPOINT,
  auth: {
    username: NEXTCLOUD_USERNAME,
    password: NEXTCLOUD_PASSWORD,
  },
  headers: {
    "Content-Type": "application/xml", // Ensure correct content type for DAV requests
  },
});

// Schemas for each function's parameters
export const TaskParams = z.object({
  task_id: z.string().describe("The unique ID of the task."),
});
export type TaskParams = z.infer<typeof TaskParams>;

export const CreateTaskParams = z.object({
  summary: z.string().describe("The summary (title) of the task."),
  description: z.string().optional().describe("The description of the task."),
  due_date: z
    .string()
    .optional()
    .describe("The due date of the task in ISO 8601 format."),
  priority: z.number().optional().describe("The priority of the task (1-9)."),
  all_day: z
    .boolean()
    .optional()
    .describe("Whether the task is an all-day event."),
  recurrence: z
    .string()
    .optional()
    .describe("The recurrence rule for the task in RRULE format."),
});
export type CreateTaskParams = z.infer<typeof CreateTaskParams>;

// Functions
export async function createTask({
  summary,
  description,
  due_date,
  priority,
  all_day,
  recurrence,
}: CreateTaskParams): Promise<object> {
  const uid = Date.now(); // Use a timestamp as a UID for simplicity

  const formatDueDate = (
    date: string | undefined,
    allDay: boolean | undefined
  ) => {
    if (!date) return "";
    const d = new Date(date);
    if (allDay) {
      return `${d.getUTCFullYear()}${(d.getUTCMonth() + 1)
        .toString()
        .padStart(2, "0")}${d.getUTCDate().toString().padStart(2, "0")}`;
    } else {
      return formatDateTime(date);
    }
  };

  const icsContent = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Your Company//Your Product//EN",
    "BEGIN:VTODO",
    `UID:${uid}@cloud.raj.how`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description || ""}`,
    due_date
      ? `${all_day ? "DUE;VALUE=DATE" : "DUE"}:${formatDueDate(
          due_date,
          all_day
        )}\r\n`
      : "",
    priority ? `PRIORITY:${priority}` : "",
    recurrence ? `RRULE:${recurrence}` : "",
    `DTSTAMP:${formatDateTime(new Date().toISOString())}`,
    all_day && due_date
      ? `DTSTART;VALUE=DATE:${formatDueDate(due_date, all_day)}`
      : "",
    !all_day && due_date ? `DTSTART:${formatDateTime(due_date)}` : "",
    "STATUS:NEEDS-ACTION",
    "END:VTODO",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n"); // Ensure no empty lines and correct formatting

  try {
    const response = await apiClient.put(
      `${TASKS_CALENDAR_NAME}/${uid}.ics`,
      icsContent,
      {
        headers: {
          "Content-Type": "text/calendar",
        },
      }
    );
    return { response: "Task created successfully" };
  } catch (error) {
    console.log(
      "Failed to create task:",
      (error as AxiosError).response?.data || (error as AxiosError).message
    );
    return {
      error: `Error: ${
        (error as AxiosError).response?.data || (error as AxiosError).message
      }`,
    };
  }
}

export const UpdateTaskParams = z.object({
  task_id: z.string().describe("The unique ID of the task to update."),
  summary: z.string().optional().describe("The updated summary of the task."),
  description: z
    .string()
    .optional()
    .describe("The updated description of the task."),
  due_date: z
    .string()
    .optional()
    .describe("The updated due date of the task in ISO 8601 format."),
  priority: z
    .number()
    .optional()
    .describe("The updated priority of the task (1-9)."),
  all_day: z
    .boolean()
    .optional()
    .describe("Whether the task is an all-day event."),
  recurrence: z
    .string()
    .optional()
    .describe("The updated recurrence rule for the task in RRULE format."),
});
export type UpdateTaskParams = z.infer<typeof UpdateTaskParams>;

export async function updateTask({
  task_id,
  summary,
  description,
  due_date,
  priority,
  all_day,
  recurrence,
}: UpdateTaskParams): Promise<object> {
  const existingTaskUrl = `${NEXTCLOUD_API_ENDPOINT}${TASKS_CALENDAR_NAME}/${task_id}.ics`;

  const retryAttempts = 3;
  const retryDelay = 1000; // 1 second delay between retries

  const formatDueDate = (
    date: string | undefined,
    allDay: boolean | undefined
  ) => {
    if (!date) return "";
    const d = new Date(date);
    if (allDay) {
      return `${d.getUTCFullYear()}${(d.getUTCMonth() + 1)
        .toString()
        .padStart(2, "0")}${d.getUTCDate().toString().padStart(2, "0")}`;
    } else {
      return formatDateTime(date);
    }
  };

  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    try {
      console.log(
        `Fetching existing task from: ${existingTaskUrl} (Attempt ${attempt})`
      );
      const existingTaskResponse = await apiClient.get(existingTaskUrl, {
        responseType: "text",
      });

      let existingTaskData = existingTaskResponse.data;

      // Modify the fields in the existing task data
      if (summary) {
        existingTaskData = existingTaskData.replace(
          /SUMMARY:.*\r\n/,
          `SUMMARY:${summary}\r\n`
        );
      }
      if (description) {
        existingTaskData = existingTaskData.replace(
          /DESCRIPTION:.*\r\n/,
          `DESCRIPTION:${description}\r\n`
        );
      }
      if (due_date) {
        const formattedDueDate = formatDueDate(due_date, all_day);
        const dueRegex = /DUE(;VALUE=DATE)?:.*\r\n/;

        // Replace existing DUE field if it exists, otherwise add it
        if (dueRegex.test(existingTaskData)) {
          existingTaskData = existingTaskData.replace(
            dueRegex,
            `${all_day ? "DUE;VALUE=DATE" : "DUE"}:${formattedDueDate}\r\n`
          );
        } else {
          existingTaskData = existingTaskData.replace(
            "STATUS:NEEDS-ACTION",
            `${
              all_day ? "DUE;VALUE=DATE" : "DUE"
            }:${formattedDueDate}\r\nSTATUS:NEEDS-ACTION`
          );
        }
      }
      if (priority) {
        existingTaskData = existingTaskData.replace(
          /PRIORITY:.*\r\n/,
          `PRIORITY:${priority}\r\n`
        );
      }
      if (recurrence) {
        if (existingTaskData.includes("RRULE")) {
          existingTaskData = existingTaskData.replace(
            /RRULE:.*\r\n/,
            `RRULE:${recurrence}\r\n`
          );
        } else {
          existingTaskData = existingTaskData.replace(
            "STATUS:NEEDS-ACTION",
            `RRULE:${recurrence}\r\nSTATUS:NEEDS-ACTION`
          );
        }
      }

      if (all_day !== undefined) {
        const dtstartRegex = /DTSTART(;VALUE=DATE)?:(\d{8}(T\d{6}Z)?)\r\n/;
        if (all_day) {
          // If all_day is true, ensure DTSTART is in DATE format
          if (dtstartRegex.test(existingTaskData)) {
            existingTaskData = existingTaskData.replace(
              dtstartRegex,
              `DTSTART;VALUE=DATE:${formatDueDate(due_date, all_day)}\r\n`
            );
          } else {
            existingTaskData = existingTaskData.replace(
              "STATUS:NEEDS-ACTION",
              `DTSTART;VALUE=DATE:${formatDueDate(
                due_date,
                all_day
              )}\r\nSTATUS:NEEDS-ACTION`
            );
          }
        } else {
          // If all_day is false, ensure DTSTART is in DATE-TIME format
          if (dtstartRegex.test(existingTaskData)) {
            existingTaskData = existingTaskData.replace(
              dtstartRegex,
              `DTSTART:${formatDateTime(
                due_date || new Date().toISOString()
              )}\r\n`
            );
          } else {
            existingTaskData = existingTaskData.replace(
              "STATUS:NEEDS-ACTION",
              `DTSTART:${formatDateTime(
                due_date || new Date().toISOString()
              )}\r\nSTATUS:NEEDS-ACTION`
            );
          }
        }
      }

      console.log("Updating task with new data...");
      const response = await apiClient.put(existingTaskUrl, existingTaskData, {
        headers: {
          "Content-Type": "text/calendar",
        },
      });

      console.log("Task updated successfully:", response.status);
      return { response: "Task updated successfully" };
    } catch (error) {
      const axiosError = error as AxiosError;

      // Check for 404 error indicating the task was not found
      if (axiosError.response?.status === 404) {
        console.log(`Task not found on attempt ${attempt}. Retrying...`);
        if (attempt < retryAttempts) {
          await new Promise((res) => setTimeout(res, retryDelay)); // Wait before retrying
          continue; // Retry the operation
        } else {
          return {
            error: `Error: Task not found with ID: ${task_id} after ${retryAttempts} attempts. Please check if the task exists.`,
          };
        }
      }

      // Log other errors
      console.log(
        `Failed to update task on attempt ${attempt}:`,
        axiosError.response?.data || axiosError.message
      );
      return {
        error: `Error: ${axiosError.response?.data || axiosError.message}`,
      };
    }
  }

  // Fallback return in case nothing else is returned (should not be reached)
  return { error: "An unexpected error occurred." };
}

export async function deleteTask({ task_id }: TaskParams) {
  try {
    const deleteUrl = `${NEXTCLOUD_API_ENDPOINT}${TASKS_CALENDAR_NAME}/${task_id}.ics`;
    console.log(`Attempting to delete task at: ${deleteUrl}`);

    const response = await apiClient.delete(deleteUrl);
    console.log("Task deleted successfully:", response.status);
    return { response: "Task deleted successfully" };
  } catch (error) {
    console.log(
      "Failed to delete task:",
      (error as AxiosError).response?.data || (error as AxiosError).message
    );
    return {
      error: `Error: ${
        (error as AxiosError).response?.data || (error as AxiosError).message
      }`,
    };
  }
}

export async function listTasks({
  start_time,
  end_time,
}: {
  start_time: string;
  end_time: string;
}): Promise<object> {
  try {
    const startISOTime = convertToISOFormat(start_time);
    const endISOTime = convertToISOFormat(end_time);

    const allTasks: any[] = [];
    const calendarUrl = `${NEXTCLOUD_API_ENDPOINT}${TASKS_CALENDAR_NAME}/`;
    console.log(`Accessing tasks calendar URL: ${calendarUrl}`);

    try {
      const testResponse = await apiClient.get(calendarUrl);
      console.log(`Test response for ${calendarUrl}: ${testResponse.status}`);
    } catch (testError) {
      console.error(
        `Error accessing ${calendarUrl}: ${(testError as AxiosError).message}`
      );
      return [];
    }

    console.log(
      `Making REPORT request to ${calendarUrl} for tasks between ${startISOTime} and ${endISOTime}`
    );

    let reportResponse;
    try {
      reportResponse = await apiClient.request({
        method: "REPORT",
        url: calendarUrl,
        headers: { Depth: "1" },
        data: `<?xml version="1.0" encoding="UTF-8"?>
<calendar-query xmlns="urn:ietf:params:xml:ns:caldav">
  <calendar-data/>
  <filter>
    <comp-filter name="VCALENDAR">
      <comp-filter name="VTODO">
        <time-range start="${startISOTime}" end="${endISOTime}"/>
      </comp-filter>
    </comp-filter>
  </filter>
</calendar-query>`,
      });
      console.log(`REPORT request successful: Status ${reportResponse.status}`);
    } catch (reportError) {
      console.error(
        `REPORT request failed for ${calendarUrl}: ${
          (reportError as AxiosError).response?.data ||
          (reportError as AxiosError).message
        }`
      );
      return [];
    }

    console.log(`Parsing iCal response for tasks`);
    const icsFiles = parseICalResponse(reportResponse.data);

    for (const icsFile of icsFiles) {
      const fullIcsUrl = `http://192.168.29.85${icsFile}?export`;
      const taskId = icsFile.split("/").pop()?.replace(".ics", "");
      console.log(`Fetching task data from ${fullIcsUrl}`);

      try {
        const taskResponse = await apiClient.get(fullIcsUrl, {
          responseType: "text",
        });
        const taskData = taskResponse.data;

        // Identify all-day events
        const isAllDay = taskData.includes("DTSTART;VALUE=DATE");

        const parsedTask = {
          task_id: taskId,
          summary: taskData.match(/SUMMARY:(.*)\r\n/)?.[1],
          description: taskData.match(/DESCRIPTION:(.*)\r\n/)?.[1],
          due_date: isAllDay
            ? taskData.match(/DUE;VALUE=DATE:(\d{8})\r\n/)?.[1]
            : taskData.match(/DUE:(\d{8}T\d{6}Z)/)?.[1],
          all_day: isAllDay,
          recurrence: taskData.match(/RRULE:(.*)\r\n/)?.[1],
        };

        allTasks.push(parsedTask);
        console.log(
          `Task data fetched and parsed successfully from ${fullIcsUrl}`
        );
      } catch (taskError) {
        console.error(
          `Failed to fetch task data from ${fullIcsUrl}: ${
            (taskError as AxiosError).response?.data ||
            (taskError as AxiosError).message
          }`
        );
      }
    }

    return allTasks;
  } catch (error) {
    console.log(
      "Final catch block error:",
      (error as AxiosError).response?.data || (error as AxiosError).message
    );
    return {
      error: `Error: ${
        (error as AxiosError).response?.data || (error as AxiosError).message
      }`,
    };
  }
}

// Helper function to convert datetime to ISO format in UTC
function formatDateTime(dateTime: string): string {
  const date = new Date(dateTime);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const seconds = date.getUTCSeconds().toString().padStart(2, "0");
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`; // UTC format required by iCalendar
}

// Integration into runnable tools
export let reminders_tools: RunnableToolFunction<any>[] = [
  zodFunction({
    function: createTask,
    name: "createReminder",
    schema: CreateTaskParams,
    description: `Create a new task (reminder).

Before creating a task, run \`listReminders\` to check if it already exists and can be updated instead.

If a similar task exists, ask the user if they want to update it instead of creating a new one.`,
  }),
  zodFunction({
    function: updateTask,
    name: "updateReminder",
    schema: UpdateTaskParams,
    description: "Update an existing task (reminder).",
  }),
  zodFunction({
    function: deleteTask,
    name: "deleteReminder",
    schema: TaskParams,
    description: "Delete a task (reminder).",
  }),
  zodFunction({
    function: listTasks,
    name: "listReminders",
    schema: z.object({
      start_time: z.string().describe("Start time in ISO 8601 format."),
      end_time: z.string().describe("End time in ISO 8601 format."),
    }),
    description: "List tasks (reminders) within a specified time range.",
  }),
];

export function getReminderSystemPrompt() {
  return `Manage your tasks and reminders using these functions to create, update, delete, and list reminders.

Keep track of important tasks and deadlines programmatically.

Use correct ISO 8601 time formats and handle task IDs carefully.

Fetch task data before updating or deleting to avoid errors or duplication.

Determine a priority level based on the user's tone and urgency of the task.`;
}

// Helper function to convert datetime to ISO format in UTC
function convertToISOFormat(dateTime: string): string {
  const date = new Date(dateTime);
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

// Helper function to parse iCal response
function parseICalResponse(response: string): string[] {
  const hrefRegex = /<d:href>([^<]+)<\/d:href>/g;
  const matches = [];
  let match;
  while ((match = hrefRegex.exec(response)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}

export const RemindersManagerParams = z.object({
  request: z.string().describe("User's request regarding reminders or tasks."),
});
export type RemindersManagerParams = z.infer<typeof RemindersManagerParams>;

export async function remindersManager(
  { request }: RemindersManagerParams,
  context_message: Message
) {
  const currentTime = new Date();
  const endOfMonth = new Date(
    currentTime.getFullYear(),
    currentTime.getMonth() + 1,
    0
  );

  const response = await ask({
    model: "gpt-4o-mini",
    prompt: `You are a reminders and tasks manager for the 'anya' calendar system.

Your job is to understand the user's request (e.g., create, update, delete, list reminders) and handle it using the available tools. Use the correct ISO 8601 time format for reminders and provide feedback about the specific action taken.

----
${memory_manager_guide("reminders_manager")}
----

Current Time: ${currentTime.toISOString()}

This Month's Reminders (${currentTime.toLocaleString()} to ${endOfMonth.toLocaleString()}):
${await listTasks({
  start_time: currentTime.toISOString(),
  end_time: endOfMonth.toISOString(),
})}
    `,
    tools: reminders_tools.concat(
      memory_manager_init(context_message, "reminders_manager")
    ) as any,
    message: request,
    seed: `reminders-${context_message.channelId}`,
  });

  return { response };
}
