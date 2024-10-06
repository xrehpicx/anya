// tools/period.ts

import { z, ZodSchema } from "zod";
import { Database } from "bun:sqlite";
import {
  RunnableToolFunction,
  RunnableToolFunctionWithParse,
} from "openai/lib/RunnableFunction.mjs";
import { JSONSchema } from "openai/lib/jsonschema.mjs";
import zodToJsonSchema from "zod-to-json-schema";
import { ask } from "./ask";
import cron from "node-cron";
import { Message } from "../interfaces/message";
import { pathInDataDir, userConfigs } from "../config";
import { getMessageInterface } from "../interfaces";

// Populate example data function
export function populateExampleData() {
  db.query("DELETE FROM period_cycles").run();
  db.query("DELETE FROM period_entries").run();
}

export function clearprdandtestdb() {
  if (db) db.close();
  const prddb = usePrdDb();
  const testdb = useTestDb();
  prddb.query("DELETE FROM period_cycles").run();
  prddb.query("DELETE FROM period_entries").run();

  testdb.query("DELETE FROM period_cycles").run();
  testdb.query("DELETE FROM period_entries").run();
}

// Util functions for managing menstrual cycle

const PeriodCycleSchema = z.object({
  id: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  description: z.string(),
  ended: z.boolean(),
});

const PeriodEntrySchema = z.object({
  id: z.string(),
  date: z.string(),
  description: z.string(),
});

export type PeriodCycleType = z.infer<typeof PeriodCycleSchema>;
export type PeriodEntryType = z.infer<typeof PeriodEntrySchema>;

let db = usePrdDb();

function usePrdDb() {
  const db_url = pathInDataDir("period.db");
  const db = new Database(db_url, { create: true });
  // Setup the tables
  db.exec("PRAGMA journal_mode = WAL;");
  db.query(
    `CREATE TABLE IF NOT EXISTS period_cycles (
      id TEXT PRIMARY KEY,
      startDate TEXT NOT NULL,
      endDate TEXT NOT NULL,
      description TEXT NOT NULL,
      ended BOOLEAN NOT NULL
    )`
  ).run();

  db.query(
    `CREATE TABLE IF NOT EXISTS period_entries (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      description TEXT NOT NULL
    )`
  ).run();
  return db;
}

function useTestDb() {
  const db_url = pathInDataDir("test_period.db");
  const db = new Database(db_url, { create: true });
  // Setup the tables
  db.exec("PRAGMA journal_mode = WAL;");
  db.query(
    `CREATE TABLE IF NOT EXISTS period_cycles (
      id TEXT PRIMARY KEY,
      startDate TEXT NOT NULL,
      endDate TEXT NOT NULL,
      description TEXT NOT NULL,
      ended BOOLEAN NOT NULL
    )`
  ).run();

  db.query(
    `CREATE TABLE IF NOT EXISTS period_entries (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      description TEXT NOT NULL
    )`
  ).run();
  return db;
}

export function getPeriodCycles() {
  const cycles = db.query("SELECT * FROM period_cycles").all();
  return cycles as PeriodCycleType[];
}

// Other utility functions remain the same...

export function getPeriodCyclesByMonth(month_index: number, year: number) {
  const startDate = new Date(year, month_index, 1).toISOString();
  const endDate = new Date(year, month_index + 1, 1).toISOString();
  const cycles = db
    .query(
      "SELECT * FROM period_cycles WHERE startDate >= $startDate AND startDate < $endDate"
    )
    .all({
      $startDate: startDate,
      $endDate: endDate,
    });
  return cycles as PeriodCycleType[];
}

export function getPeriodCycleByDateRange(startDate: Date, endDate: Date) {
  const cycles = db
    .query(
      "SELECT * FROM period_cycles WHERE startDate >= $startDate AND startDate < $endDate"
    )
    .all({
      $startDate: startDate.toISOString(),
      $endDate: endDate.toISOString(),
    });
  return cycles as PeriodCycleType[];
}

export function createPeriodCycle(
  startDate: Date,
  endDate: Date,
  ended?: boolean
) {
  db.query(
    `INSERT INTO period_cycles (id, startDate, endDate, description, ended) VALUES
            ($id, $startDate, $endDate, $description, $ended)`
  ).run({
    $id: Math.random().toString(36).substring(2, 15),
    $startDate: startDate.toISOString(),
    $endDate: endDate.toISOString(),
    $description: `Started on ${startDate.toISOString()}`,
    $ended: ended ? 1 : 0,
  });
}

export function getAverageCycleLength() {
  const cycles = getPeriodCycles();
  const totalLength = cycles.reduce((acc, cycle) => {
    const startDate = new Date(cycle.startDate);
    const endDate = new Date(cycle.endDate);
    return acc + (endDate.getTime() - startDate.getTime()) / 86400000;
  }, 0);
  return totalLength / cycles.length;
}

export function updateEndDatePeriodCycle(id: string, endDate: Date) {
  db.query("UPDATE period_cycles SET endDate = $endDate WHERE id = $id").run({
    $id: id,
    $endDate: endDate.toISOString(),
  });
}

export function updateDiscriptionPeriodCycle(id: string, discription: string) {
  db.query(
    "UPDATE period_cycles SET description = $description WHERE id = $id"
  ).run({
    $id: id,
    $description: discription,
  });
}

export function endPeriodCycle(id: string, discription?: string) {
  db.query("UPDATE period_cycles SET ended = 1 WHERE id = $id").run({
    $id: id,
  });
  updateEndDatePeriodCycle(id, new Date());
  if (discription) {
    updateDiscriptionPeriodCycle(id, discription);
  }
}

export function getOngoingPeriodCycle() {
  const cycle = db.query("SELECT * FROM period_cycles WHERE ended = 0").get();
  return cycle as PeriodCycleType;
}

export function getPeriodEntries() {
  const entries = db.query("SELECT * FROM period_entries").get();
  return entries as PeriodEntryType[];
}

export function getLatestPeriodEntry() {
  const entry = db
    .query("SELECT * FROM period_entries ORDER BY date DESC")
    .get();
  return entry as PeriodEntryType;
}

export function getPeriodEntriesByDateRange(startDate: Date, endDate: Date) {
  const entries = db
    .query(
      "SELECT * FROM period_entries WHERE date >= $startDate AND date < $endDate"
    )
    .all({
      $startDate: startDate.toISOString(),
      $endDate: endDate.toISOString(),
    });
  return entries as PeriodEntryType[];
}

export function getPeriodEntryByDate(date: Date) {
  const entry = db
    .query("SELECT * FROM period_entries WHERE date = $date")
    .get({ $date: date.toISOString() });
  return entry as PeriodEntryType;
}

export function updatePeriodEntryByDate(date: Date, description: string) {
  db.query(
    "UPDATE period_entries SET description = $description WHERE date = $date"
  ).run({
    $date: date.toISOString(),
    $description: description,
  });
}

export function createPeriodEntry(date: Date, description: string) {
  db.query(
    `INSERT INTO period_entries (id, date, description) VALUES
            ($id, $date, $description)`
  ).run({
    $id: Math.random().toString(36).substring(2, 15),
    $date: date.toISOString(),
    $description: description,
  });
}

// OpenAI tools to manage the cycles

// Create cycle tool
export const CreatePeriodCycleParams = z.object({
  startDate: z
    .string()
    .describe("Date of the start of the period cycle in ISO string format IST"),
  endDate: z
    .string()
    .describe(
      "The estimated end date of the period cycle. Ask the user how long their period usually lasts and use that data to calculate this. This has to be in ISO string format IST"
    ),
});

export type CreatePeriodCycleParamsType = z.infer<
  typeof CreatePeriodCycleParams
>;

export async function startNewPeriodCycle({
  startDate,
  endDate,
}: CreatePeriodCycleParamsType) {
  if (!startDate || !endDate) {
    return { error: "startDate and endDate are required" };
  }

  // Check if there is an ongoing cycle
  const ongoing = getOngoingPeriodCycle();
  if (ongoing) {
    return {
      error: "There is already an ongoing cycle",
      ongoingCycle: ongoing,
    };
  }

  createPeriodCycle(new Date(startDate), new Date(endDate));
  return { message: "Started a new period cycle" };
}

// Create old period cycle tool
export const CreateOldPeriodCycleParams = z.object({
  startDate: z
    .string()
    .describe("Date of the start of the period cycle in ISO string format IST"),
  endDate: z
    .string()
    .describe(
      "When did this cycle end. This has to be in ISO string format IST"
    ),
});

export type CreateOldPeriodCycleParamsType = z.infer<
  typeof CreateOldPeriodCycleParams
>;

export async function createOldPeriodCycle({
  startDate,
  endDate,
}: CreateOldPeriodCycleParamsType) {
  if (!startDate || !endDate) {
    return { error: "startDate and endDate are required" };
  }

  createPeriodCycle(new Date(startDate), new Date(endDate), true);
  return { message: "Started a new period cycle" };
}

// Create entry tool
export const CreatePeriodEntryParams = z.object({
  date: z
    .string()
    .describe(
      "Specify a date & time to add a past entry, no need to specify for a new entry"
    )
    .default(new Date().toISOString())
    .optional(),
  description: z
    .string()
    .describe("Description of the vibe the user felt on the day"),
});

export type CreatePeriodEntryParamsType = z.infer<
  typeof CreatePeriodEntryParams
>;

export async function addOrUpdatePeriodEntryTool({
  date,
  description,
}: CreatePeriodEntryParamsType) {
  date = date || (new Date().toISOString() as string);

  try {
    const cycles = getPeriodCycleByDateRange(
      new Date(new Date().setFullYear(new Date().getFullYear() - 1)),
      new Date()
    );
    if (cycles.length === 0) {
      return {
        error:
          "You cannot update or add to a cycle that's more than a year old",
      };
    }

    const cycle = cycles.find(
      (cycle) =>
        new Date(date as string) >= new Date(cycle.startDate) &&
        new Date(date as string) <= new Date(cycle.endDate)
    );

    if (!cycle) {
      console.log(
        cycle,
        "error: The specified date does not seem to be part of any existing cycle. Please check the date and/or start a new cycle from this date and try again."
      );
      return {
        error:
          "The specified date does not seem to be part of any existing cycle. Please check the date and/or start a new cycle from this date and try again.",
      };
    }

    createPeriodEntry(new Date(date), description);
    return {
      message: "Added a new entry",
    };
  } catch (error) {
    console.log(error);
    return {
      error: "An error occurred while processing the request",
    };
  }
}

// End cycle tool

export const EndPeriodCycleParams = z.object({
  description: z
    .string()
    .describe("How did the user feel during this cycle on average"),
});

export type EndPeriodCycleParamsType = z.infer<typeof EndPeriodCycleParams>;

export async function endPeriodCycleTool({
  description,
}: EndPeriodCycleParamsType) {
  const ongoingCycle = getOngoingPeriodCycle();
  const id = ongoingCycle ? ongoingCycle.id : null;

  if (!id) {
    return { error: "There is no ongoing cycle" };
  }

  endPeriodCycle(id, description);
  return { message: "Ended the period cycle" };
}

// Get current cycle tool
export const GetCurrentPeriodCycleParams = z.object({});

export type GetCurrentPeriodCycleParamsType = z.infer<
  typeof GetCurrentPeriodCycleParams
>;

export async function getCurrentPeriodCycleTool() {
  try {
    const cycle = getOngoingPeriodCycle();

    console.log(cycle);

    // Days since period started
    const noOfDaysSinceStart = Math.floor(
      (new Date().getTime() - new Date(cycle.startDate).getTime()) / 86400000
    );

    const averageCycleLength = getAverageCycleLength();

    let note =
      averageCycleLength > 4
        ? noOfDaysSinceStart > averageCycleLength
          ? "Cycle is overdue"
          : ""
        : undefined;

    if (cycle.ended) {
      note =
        "There are no ongoing cycles. This is just the last cycle that ended.";
    }

    if (!cycle.ended) {
      const endDate = new Date(cycle.endDate);
      if (endDate < new Date()) {
        note = "Cycle is overdue, or you forgot to end the cycle.";
      }
    }

    const response = {
      cycle,
      todaysDate: new Date().toISOString(),
      noOfDaysSinceStart: cycle.ended ? undefined : noOfDaysSinceStart,
      averageCycleLength,
      note,
    };

    return response;
  } catch (error) {
    console.log(error);
    return {
      error: "No ongoing cycle",
    };
  }
}

// Get entries in a date range tool
export const GetPeriodEntriesParams = z.object({
  startDate: z.string().describe("Start date in ISO string format IST"),
  endDate: z.string().describe("End date in ISO string format IST"),
});

export type GetPeriodEntriesParamsType = z.infer<typeof GetPeriodEntriesParams>;

export async function getPeriodEntriesTool({
  startDate,
  endDate,
}: GetPeriodEntriesParamsType) {
  const entries = getPeriodEntriesByDateRange(
    new Date(startDate),
    new Date(endDate)
  );
  return entries;
}

// Get vibe by date range tool
export const GetVibeByDateRangeParams = z.object({
  startDate: z.string().describe("Start date in ISO string format IST"),
  endDate: z.string().describe("End date in ISO string format IST"),
});

export type GetVibeByDateRangeParamsType = z.infer<
  typeof GetVibeByDateRangeParams
>;

export async function getVibeByDateRangeTool({
  startDate,
  endDate,
}: GetVibeByDateRangeParamsType) {
  const entries = getPeriodEntriesByDateRange(
    new Date(startDate),
    new Date(endDate)
  );

  ask({
    prompt: `Give me the general summary from the below entries that are a part of a period cycle:
    ----
    [${entries.map((entry) => entry.description).join("\n")}]
    ----

    The above are entries from ${startDate} to ${endDate}
    You need to give a general short summary of how the user felt during this period.
    `,
  });

  return entries;
}

// Get cycle by date range tool
export const GetPeriodCycleByDateRangeParams = z.object({
  startDate: z.string().describe("Start date in ISO string format IST"),
  endDate: z.string().describe("End date in ISO string format IST"),
});

export type GetPeriodCycleByDateRangeParamsType = z.infer<
  typeof GetPeriodCycleByDateRangeParams
>;

export async function getPeriodCycleByDateRangeTool({
  startDate,
  endDate,
}: GetPeriodCycleByDateRangeParamsType) {
  const cycles = getPeriodCycleByDateRange(
    new Date(startDate),
    new Date(endDate)
  );
  return cycles;
}

// Get latest period entry tool
export const GetLatestPeriodEntryParams = z.object({});
export type GetLatestPeriodEntryParamsType = z.infer<
  typeof GetLatestPeriodEntryParams
>;

export async function getLatestPeriodEntryTool() {
  const entry = getLatestPeriodEntry();
  return entry;
}

// Updated getPeriodTools function
export function getPeriodTools(
  context_message: Message
): RunnableToolFunction<any>[] {
  const userRoles = context_message.getUserRoles();

  if (!userRoles.includes("periodUser")) {
    // User does not have access to period tools
    return [];
  }

  db.close();
  db = usePrdDb();

  return [
    zodFunction({
      function: startNewPeriodCycle,
      name: "startNewPeriodCycle",
      schema: CreatePeriodCycleParams,
      description: `Start a new period cycle.
      You can specify the start date and end date.
      You need to ask how the user is feeling and make a period entry about this.`,
    }),
    zodFunction({
      function: createOldPeriodCycle,
      name: "createOldPeriodCycle",
      schema: CreateOldPeriodCycleParams,
      description: `Create a period cycle that has already ended.
        If the user wants to add entries of older period cycles, you can create a cycle that has already ended.
        Ask the user for the start date and end date of the cycle in natural language.
        `,
    }),
    zodFunction({
      function: addOrUpdatePeriodEntryTool,
      name: "addOrUpdatePeriodEntry",
      schema: CreatePeriodEntryParams,
      description: `Add or update a period entry. If the entry for the date already exists, it will be updated.`,
    }),
    zodFunction({
      function: endPeriodCycleTool,
      name: "endPeriodCycle",
      schema: EndPeriodCycleParams,
      description: `End ongoing period cycle. Make sure to confirm with the user before ending the cycle.
      Ask the user if their cycle needs to be ended if it's been more than 7 days since the start date of the cycle.`,
    }),
    zodFunction({
      function: getCurrentPeriodCycleTool,
      name: "getCurrentPeriodCycle",
      schema: GetCurrentPeriodCycleParams,
      description: `Get the ongoing period cycle.
      This returns the ongoing period cycle, the number of days since the cycle started, and the average cycle length.
      `,
    }),
    zodFunction({
      function: getPeriodEntriesTool,
      name: "getPeriodEntriesByDateRange",
      schema: GetPeriodEntriesParams,
      description: "Get period entries in a date range",
    }),
    zodFunction({
      function: getPeriodCycleByDateRangeTool,
      name: "getPeriodCycleByDateRange",
      schema: GetPeriodCycleByDateRangeParams,
      description: "Get period cycles in a date range",
    }),
    zodFunction({
      function: getLatestPeriodEntryTool,
      name: "getLatestPeriodEntry",
      schema: GetLatestPeriodEntryParams,
      description: "Get the latest period entry",
    }),
    zodFunction({
      function: getVibeByDateRangeTool,
      name: "getVibeByDateRange",
      schema: GetVibeByDateRangeParams,
      description: `Get the general vibe of the user in a date range.
        This will ask the user to give a general summary of how they felt during this period.
        `,
    }),
  ];
}

export function zodFunction<T extends object>({
  function: fn,
  schema,
  description = "",
  name,
}: {
  function: (args: T) => Promise<object>;
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

// Updated startPeriodJob function
var jobStarted = false;
export function startPeriodJob() {
  if (jobStarted) return;
  const timezone = "Asia/Kolkata";
  cron.schedule(
    "0 */4 * * *",
    async () => {
      console.log("Checking for period entries in the last 2 hours");

      // Get users with 'periodUser' role but not 'testingPeriodUser'
      const periodUsers = userConfigs.filter(
        (user) =>
          user.roles.includes("periodUser") &&
          !user.roles.includes("testingPeriodUser")
      );

      for (const user of periodUsers) {
        // Assuming you have a function to send messages to users based on their identities
        for (const identity of user.identities) {
          // Fetch or create a Message object for each user identity
          const context_message: Message = await getMessageInterface(identity);

          const cycle = getOngoingPeriodCycle();
          if (!cycle) continue;

          const entry = getLatestPeriodEntry();
          const isOldEntry =
            new Date(entry.date) < new Date(new Date().getTime() - 14400000);

          if (isOldEntry) {
            const message_for_user = await ask({
              prompt: `Generate a message to remind the user to make a period entry.

              Ask the user how they are feeling about their period cycle as it's been a while since they updated how they felt.
              Do not explicitly ask them to make an entry, just ask them how they are feeling about their period.

              Today's date: ${new Date().toISOString()}

              Ongoing cycle: ${JSON.stringify(cycle)}

              Note: if the end date is in the past then ask the user if the cycle is still going on or if it's okay to end the cycle.

              Last entry: ${JSON.stringify(entry)}`,
            });

            if (message_for_user.choices[0].message.content) {
              await context_message.send({
                content: message_for_user.choices[0].message.content,
              });
            } else {
              console.log("No message generated");
            }
          }
        }
      }
    },
    {
      timezone,
      recoverMissedExecutions: true,
      runOnInit: true,
    }
  );
  jobStarted = true;
}
