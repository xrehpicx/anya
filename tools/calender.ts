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

const CALENDAR_NAME = "anya"; // Primary read-write calendar
const READ_ONLY_CALENDARS = ["google"]; // Read-only calendar

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
export const EventParams = z.object({
  event_id: z.string().describe("The unique ID of the event."),
  calendar: z
    .string()
    .optional()
    .describe("The calendar the event belongs to."),
});
export type EventParams = z.infer<typeof EventParams>;

export const CreateEventParams = z.object({
  summary: z.string().describe("The summary (title) of the event."),
  description: z.string().optional().describe("The description of the event."),
  start_time: z
    .string()
    .describe("The start time of the event in ISO 8601 format."),
  end_time: z
    .string()
    .describe("The end time of the event in ISO 8601 format."),
  location: z.string().optional().describe("The location of the event."),
  attendees: z
    .array(z.string())
    .optional()
    .describe("List of attendee email addresses."),
  all_day: z
    .boolean()
    .optional()
    .describe("Whether the event is an all-day event."),
  recurrence: z
    .string()
    .optional()
    .describe("The recurrence rule for the event in RRULE format."),
});
export type CreateEventParams = z.infer<typeof CreateEventParams>;

export const UpdateEventParams = z.object({
  event_id: z.string().describe("The unique ID of the event to update."),
  summary: z.string().optional().describe("The updated summary of the event."),
  description: z
    .string()
    .optional()
    .describe("The updated description of the event."),
  start_time: z
    .string()
    .optional()
    .describe("The updated start time in ISO 8601 format."),
  end_time: z
    .string()
    .optional()
    .describe("The updated end time in ISO 8601 format."),
  location: z
    .string()
    .optional()
    .describe("The updated location of the event."),
  attendees: z
    .array(z.string())
    .optional()
    .describe("Updated list of attendee email addresses."),
  calendar: z
    .string()
    .optional()
    .describe("The calendar the event belongs to."),
  all_day: z
    .boolean()
    .optional()
    .describe("Whether the event is an all-day event."),
  recurrence: z
    .string()
    .optional()
    .describe("The updated recurrence rule for the event in RRULE format."),
});
export type UpdateEventParams = z.infer<typeof UpdateEventParams>;

function validateRecurrenceRule(recurrence: string): boolean {
  const rrulePattern =
    /^RRULE:(FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY);?(\w+=\w+;?)*)$/;
  return rrulePattern.test(recurrence);
}

// Functions
export async function createEvent({
  summary,
  description,
  start_time,
  end_time,
  location,
  attendees,
  all_day,
  recurrence,
}: CreateEventParams) {
  const formatTime = (dateTime: string, allDay: boolean | undefined) => {
    if (allDay) {
      const date = new Date(dateTime);
      return `${date.getUTCFullYear()}${(date.getUTCMonth() + 1)
        .toString()
        .padStart(2, "0")}${date.getUTCDate().toString().padStart(2, "0")}`;
    } else {
      return formatDateTime(dateTime);
    }
  };

  if (recurrence && !validateRecurrenceRule(recurrence)) {
    return { error: "Invalid recurrence rule syntax." };
  }

  // Ensure DTEND for all-day events is correctly handled (should be the next day)
  const dtend = all_day
    ? formatTime(end_time || start_time, all_day)
    : formatTime(end_time, all_day);

  const icsContent = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//xrehpicx//anya//EN",
    "BEGIN:VEVENT",
    `UID:${Date.now()}@cloud.raj.how`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description || ""}`,
    `DTSTART${all_day ? ";VALUE=DATE" : ""}:${formatTime(start_time, all_day)}`,
    `DTEND${all_day ? ";VALUE=DATE" : ""}:${dtend}`,
    `LOCATION:${location || ""}`,
    attendees
      ? attendees
          .map((email) => `ATTENDEE;CN=${email}:mailto:${email}`)
          .join("\r\n")
      : "",
    recurrence || "",
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");

  try {
    const response = await apiClient.put(
      `${CALENDAR_NAME}/${Date.now()}.ics`,
      icsContent
    );
    return { response: "Event created successfully" };
  } catch (error) {
    console.log("Failed to create event:", error);
    console.log((error as AxiosError<any>).response?.data);
    return {
      error: `Error: ${error}\n${(error as AxiosError<any>).response?.data}`,
    };
  }
}

export async function updateEvent({
  event_id,
  summary,
  description,
  start_time,
  end_time,
  location,
  attendees,
  calendar = CALENDAR_NAME,
  all_day,
  recurrence,
}: UpdateEventParams) {
  if (READ_ONLY_CALENDARS.includes(calendar)) {
    return { error: "This event is read-only and cannot be updated." };
  }

  // Fetch the existing event to ensure we have all required data
  const existingEvent = await getEvent({ event_id, calendar });

  if (existingEvent.error) {
    return { error: "Event not found" };
  }

  // Determine whether the event is all-day, and format times accordingly
  const isAllDay = all_day !== undefined ? all_day : existingEvent.all_day;
  const formatTime = (
    dateTime: string | undefined,
    allDay: boolean
  ): string => {
    if (!dateTime) return "";
    if (allDay) {
      const date = new Date(dateTime);
      return `${date.getUTCFullYear()}${(date.getUTCMonth() + 1)
        .toString()
        .padStart(2, "0")}${date.getUTCDate().toString().padStart(2, "0")}`;
    } else {
      return formatDateTime(dateTime);
    }
  };

  if (recurrence && !validateRecurrenceRule(recurrence)) {
    return { error: "Invalid recurrence rule syntax." };
  }

  // Format the ICS content, ensuring that all required fields are present
  const updatedICSContent = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//xrehpicx//anya//EN",
    "BEGIN:VEVENT",
    `UID:${event_id}`,
    `SUMMARY:${summary || existingEvent.summary}`,
    `DESCRIPTION:${description || existingEvent.description}`,
    `DTSTART${isAllDay ? ";VALUE=DATE" : ""}:${formatTime(
      start_time || existingEvent.start_time,
      isAllDay
    )}`,
    `DTEND${isAllDay ? ";VALUE=DATE" : ""}:${formatTime(
      end_time || existingEvent.end_time,
      isAllDay
    )}`,
    `LOCATION:${location || existingEvent.location}`,
    attendees
      ? attendees
          .map((email) => `ATTENDEE;CN=${email}:mailto:${email}`)
          .join("\r\n")
      : existingEvent.attendees,
    recurrence || existingEvent.recurrence,
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");

  try {
    const response = await apiClient.put(
      `${calendar}/${event_id}.ics`,
      updatedICSContent
    );

    return { response: "Event updated successfully" };
  } catch (error) {
    console.log("Failed to update event:", error);
    console.log((error as AxiosError<any>).response?.data);
    return {
      error: `Error: ${error}\n${(error as AxiosError<any>).response?.data}`,
    };
  }
}

export async function deleteEvent({ event_id }: EventParams) {
  try {
    const deleteUrl = `${NEXTCLOUD_API_ENDPOINT}${CALENDAR_NAME}/${event_id}.ics`; // Correctly form the URL
    console.log(`Attempting to delete event at: ${deleteUrl}`);

    const response = await apiClient.delete(deleteUrl);
    console.log("Event deleted successfully:", response.status);
    return { response: "Event deleted successfully" };
  } catch (error) {
    console.log(
      "Failed to delete event:",
      (error as AxiosError).response?.data || (error as AxiosError).message
    );
    return {
      error: `Error: ${
        (error as AxiosError).response?.data || (error as AxiosError).message
      }`,
    };
  }
}

export async function getEvent({
  event_id,
  calendar = CALENDAR_NAME,
}: EventParams) {
  try {
    const response = await apiClient.get(`${calendar}/${event_id}.ics`);
    const eventData = response.data;
    const isReadOnly = READ_ONLY_CALENDARS.includes(calendar);

    return {
      ...eventData,
      read_only: isReadOnly ? "Read-Only" : "Editable",
    };
  } catch (error) {
    console.log(error);
    return {
      error: `Error: ${error}\n${(error as AxiosError<any>).response?.data}`,
    };
  }
}

export async function listEvents({
  start_time,
  end_time,
}: {
  start_time: string;
  end_time: string;
}) {
  try {
    const startISOTime = convertToISOFormat(start_time);
    const endISOTime = convertToISOFormat(end_time);

    const allEvents: any[] = [];

    for (const calendar of [CALENDAR_NAME, ...READ_ONLY_CALENDARS]) {
      const calendarUrl = `${NEXTCLOUD_API_ENDPOINT}${calendar}/`;
      console.log(`Accessing calendar URL: ${calendarUrl}`);

      try {
        const testResponse = await apiClient.get(calendarUrl);
        console.log(`Test response for ${calendarUrl}: ${testResponse.status}`);
      } catch (testError) {
        console.error(
          `Error accessing ${calendarUrl}: ${(testError as AxiosError).message}`
        );
        continue;
      }

      console.log(
        `Making REPORT request to ${calendarUrl} for events between ${startISOTime} and ${endISOTime}`
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
        <comp-filter name="VEVENT">
          <time-range start="${startISOTime}" end="${endISOTime}"/>
        </comp-filter>
      </comp-filter>
    </filter>
  </calendar-query>`,
        });
        console.log(
          `REPORT request successful: Status ${reportResponse.status}`
        );
      } catch (reportError) {
        console.error(
          `REPORT request failed for ${calendarUrl}: ${
            (reportError as AxiosError).response?.data ||
            (reportError as AxiosError).message
          }`
        );
        continue;
      }

      console.log(`Parsing iCal response for calendar ${calendar}`);
      const icsFiles = parseICalResponse(reportResponse.data);

      for (const icsFile of icsFiles) {
        const fullIcsUrl = `http://192.168.29.85${icsFile}?export`;
        const eventId = icsFile.split("/").pop()?.replace(".ics", "");
        console.log(`Fetching event data from ${fullIcsUrl}`);

        try {
          const eventResponse = await apiClient.get(fullIcsUrl, {
            responseType: "text",
          });
          const eventData = eventResponse.data;

          allEvents.push({
            event_id: eventId, // Add event ID explicitly here
            data: eventData,
            calendar,
            read_only: READ_ONLY_CALENDARS.includes(calendar)
              ? "Read-Only"
              : "Editable",
          });
          console.log(`Event data fetched successfully from ${fullIcsUrl}`);
        } catch (eventError) {
          console.error(
            `Failed to fetch event data from ${fullIcsUrl}: ${
              (eventError as AxiosError).response?.data ||
              (eventError as AxiosError).message
            }`
          );
        }
      }
    }

    return allEvents;
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

// Helper function to format datetime for iCalendar
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
export let calendar_tools: RunnableToolFunction<any>[] = [
  zodFunction({
    function: createEvent,
    name: "createCalendarEvent",
    schema: CreateEventParams,
    description: "Create a new event in the 'anya' calendar.",
  }),
  zodFunction({
    function: updateEvent,
    name: "updateCalendarEvent",
    schema: UpdateEventParams,
    description:
      "Update an event in the 'anya' calendar. Cannot update read-only events.",
  }),
  zodFunction({
    function: deleteEvent,
    name: "deleteCalendarEvent",
    schema: EventParams,
    description:
      "Delete an event from the 'anya' calendar. Cannot delete read-only events.",
  }),
  zodFunction({
    function: getEvent,
    name: "getCalendarEvent",
    schema: EventParams,
    description:
      "Retrieve an event from the 'anya' calendar. Indicates if the event is read-only.",
  }),
  zodFunction({
    function: listEvents,
    name: "listCalendarEvents",
    schema: z.object({
      start_time: z.string().describe("Start time in ISO 8601 format."),
      end_time: z.string().describe("End time in ISO 8601 format."),
    }),
    description:
      "List events within a time range from the 'anya' calendar, including read-only events.",
  }),
];

export function getCalendarSystemPrompt() {
  return `Manage your 'anya' calendar on Nextcloud using these functions to create, update, delete, and list events.

Read-only events cannot be updated or deleted; they are labeled as "Read-Only" when retrieved or listed.

Use correct ISO 8601 time formats and handle event IDs carefully.

**Do not use this for reminders.**

User's primary emails: r@raj.how and raj@cloud.raj.how

When creating or updating an event, inform the user of the event date or details updated.
`;
}

export const CalendarManagerParams = z.object({
  request: z.string().describe("User's request regarding calendar events."),
});
export type CalendarManagerParams = z.infer<typeof CalendarManagerParams>;

export async function calendarManager(
  { request }: CalendarManagerParams,
  context_message: Message
) {
  // Set start and end dates for listing events
  const startDate = new Date();
  startDate.setDate(1);
  startDate.setMonth(startDate.getMonth() - 1);
  const endDate = new Date();
  endDate.setDate(1);
  endDate.setMonth(endDate.getMonth() + 2);

  const response = await ask({
    model: "gpt-4o-mini",
    prompt: `You are a calendar manager for the 'anya' calendar on Nextcloud.

Understand the user's request regarding calendar events (create, update, delete, list) and handle it using available tools.

Use correct ISO 8601 time formats. Provide feedback about actions taken, including event dates or details updated.

User's primary emails: r@raj.how and raj@cloud.raj.how. Inform the user of the date of any created or updated event.

----
${memory_manager_guide("calendar_manager", context_message.author.id)}
----

Current Time: ${new Date().toISOString()}

Events from ${startDate.toISOString()} to ${endDate.toISOString()}:
${await listEvents({
  start_time: startDate.toISOString(),
  end_time: endDate.toISOString(),
})}
    `,
    tools: calendar_tools.concat(
      memory_manager_init(context_message, "calendar_manager")
    ) as any,
    message: request,
    seed: `calendar-manager-${context_message.channelId}`,
  });

  return { response };
}
