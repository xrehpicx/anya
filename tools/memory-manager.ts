import { z } from "zod";
import fs from "fs";
import { randomUUID } from "crypto";
import { Message } from "../interfaces/message";
import { zodFunction } from ".";
import { ask } from "./ask";
import { pathInDataDir } from "../config";

export const CreateMemorySchema = z.object({
  memory: z.string(),
});

export type CreateMemory = z.infer<typeof CreateMemorySchema>;

export const UpdateMemorySchema = z.object({
  id: z.string(),
  memory: z.string(),
});

export type UpdateMemory = z.infer<typeof UpdateMemorySchema>;

export const DeleteMemorySchema = z.object({
  id: z.string(),
});

export type DeleteMemory = z.infer<typeof DeleteMemorySchema>;

const memory_path = pathInDataDir("memories.json");

type Memories = Record<
  string, // manager_id
  Record<
    string, // user_id
    {
      id: string;
      memory: string;
      created_at: string;
      updated_at: string;
    }[]
  >
>;

// if the file doesn't exist, create it
if (!fs.existsSync(memory_path)) {
  fs.writeFileSync(memory_path, "{}");
}

function getMemories(): Memories {
  return JSON.parse(fs.readFileSync(memory_path, "utf-8"));
}

export function getMemoriesByManager(manager_id: string, user_id: string) {
  const memories = getMemories();
  return memories[manager_id]?.[user_id] || [];
}

function saveMemories(memories: Memories) {
  fs.writeFileSync(memory_path, JSON.stringify(memories, null, 2));
}

export function createMemory(
  params: CreateMemory,
  manager_id: string,
  user_id: string
) {
  try {
    const memories = getMemories();
    memories[manager_id] = memories[manager_id] || {};
    memories[manager_id][user_id] = memories[manager_id][user_id] || [];
    if (memories[manager_id][user_id].length >= 5) {
      return { error: "You have reached the limit of memories." };
    }
    const uuid = randomUUID();
    const start = Math.floor(Math.random() * (uuid.length - 4));
    const new_mem = {
      id: uuid.slice(start, start + 4),
      memory: params.memory,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    memories[manager_id][user_id].push(new_mem);
    saveMemories(memories);
    return { id: new_mem.id };
  } catch (error) {
    return { error };
  }
}

export function updateMemory(
  params: UpdateMemory,
  manager_id: string,
  user_id: string
) {
  try {
    const memories = getMemories();
    memories[manager_id] = memories[manager_id] || {};
    memories[manager_id][user_id] = memories[manager_id][user_id] || [];
    const memory = memories[manager_id][user_id].find(
      (m) => m.id === params.id
    );
    if (!memory) {
      return { error: "Memory not found" };
    }
    memory.memory = params.memory;
    memory.updated_at = new Date().toISOString();
    saveMemories(memories);
    return {};
  } catch (error) {
    return { error };
  }
}

export function deleteMemory(
  params: DeleteMemory,
  manager_id: string,
  user_id: string
) {
  try {
    const memories = getMemories();
    memories[manager_id] = memories[manager_id] || {};
    memories[manager_id][user_id] = memories[manager_id][user_id] || [];
    memories[manager_id][user_id] = memories[manager_id][user_id].filter(
      (m) => m.id !== params.id
    );
    saveMemories(memories);
    return {};
  } catch (error) {
    return { error };
  }
}

export const memory_tools = (manager_id: string, user_id: string) => [
  zodFunction({
    function: (args) => createMemory(args, manager_id, user_id),
    name: "create_memory",
    schema: CreateMemorySchema,
    description: "Create a memory.",
  }),
  zodFunction({
    function: (args) => updateMemory(args, manager_id, user_id),
    name: "update_memory",
    schema: UpdateMemorySchema,
    description: "Update a memory.",
  }),
  zodFunction({
    function: (args) => deleteMemory(args, manager_id, user_id),
    name: "delete_memory",
    schema: DeleteMemorySchema,
    description: "Delete a memory.",
  }),
];

const MemoryManagerSchema = z.object({
  request: z.string(),
});

export type MemoryManager = z.infer<typeof MemoryManagerSchema>;

async function memoryManager(
  params: MemoryManager,
  context_message: Message,
  manager_id: string
) {
  try {
    const user_id = context_message.author.id;
    const current_memories = getMemoriesByManager(manager_id, user_id);
    const tools = memory_tools(manager_id, user_id);

    const response = await ask({
      model: "gpt-4o-mini",
      prompt: `You are a Memories Manager.

You manage memories for other managers.

Help the manager with their request based on the information provided.

- **Priority:** Only store useful and detailed memories.
  - If the request is not useful or lacks detail, ask for more information or deny the request.
- When a manager reaches the memory limit, ask them to choose memories to delete. Ensure they inform their user about the deletion and confirm before proceeding.
- Ensure the memories are relevant to the requesting manager.
- Return the ID of any memory you save so the manager can refer to it later.

**Current Manager:** ${manager_id}

**Their Memories:**
${JSON.stringify(current_memories)}
      `,
      message: params.request,
      name: manager_id,
      seed: `memory-man-${manager_id}-${
        context_message.author.id ?? context_message.author.username
      }`,
      tools,
    });

    return {
      response: response.choices[0].message.content,
    };
  } catch (error) {
    return { error };
  }
}

export const memory_manager_init = (
  context_message: Message,
  manager_id: string
) => {
  return zodFunction({
    function: (args) => memoryManager(args, context_message, manager_id),
    name: "memory_manager",
    schema: MemoryManagerSchema,
    description:
      `Manages memories for a manager or yourself.

- Memories are isolated per manager and per user; managers can't access each other's memories, and users can't access other users' memories.
- **Use Cases:**
- Remembering important user preferences.
- Anything you want to recall later.

**Examples:**
- "Remember to use \`home_assistant_manager\` when the user asks to set text on a widget."
- "Remember that the user mainly cares about the P4 system service status."

Memories are limited and costly; use them wisely.
` +
      (manager_id === "self"
        ? `### Important Note
Make sure you only use this for your own memories and not for other memories that you can tell other managers to remember.
`
        : ""),
  });
};

export const memory_manager_guide = (
  manager_id: string,
  user_id: string
) => `# Memories Saved for You

${JSON.stringify(getMemoriesByManager(manager_id, user_id), null, 2)}

You can store up to 5 memories at a time. Use them wisely.
`;
