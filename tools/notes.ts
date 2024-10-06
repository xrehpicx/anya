import { createClient, ResponseDataDetailed } from "webdav";
import { z } from "zod";
import { zodFunction } from ".";
import { RunnableToolFunction } from "openai/lib/RunnableFunction.mjs";
import Fuse from "fuse.js";
import { ask } from "./ask";
import { Message } from "../interfaces/message";
import { memory_manager_guide, memory_manager_init } from "./memory-manager";

// Initialize WebDAV client
const client = createClient("http://192.168.29.85/remote.php/dav/files/raj/", {
  username: process.env.NEXTCLOUD_USERNAME!,
  password: process.env.NEXTCLOUD_PASSWORD!,
});

// Types
export type OperationResult = { success: boolean; message: string | object };
// Schemas for function parameters
export const CreateFileParams = z.object({
  path: z.string().describe("The path for the new file."),
  content: z.string().describe("The content for the new file."),
});
export type CreateFileParams = z.infer<typeof CreateFileParams>;

export const CreateDirectoryParams = z.object({
  path: z.string().describe("The path for the new directory."),
});
export type CreateDirectoryParams = z.infer<typeof CreateDirectoryParams>;

export const DeleteItemParams = z.object({
  path: z.string().describe("The path to the file or directory to be deleted."),
});
export type DeleteItemParams = z.infer<typeof DeleteItemParams>;

export const MoveItemParams = z.object({
  source_path: z
    .string()
    .describe("The current path of the file or directory."),
  destination_path: z
    .string()
    .describe("The new path where the file or directory will be moved."),
});
export type MoveItemParams = z.infer<typeof MoveItemParams>;

export const SearchFilesParams = z.object({
  query: z
    .string()
    .describe("The query string to search for file names or content."),
});
export type SearchFilesParams = z.infer<typeof SearchFilesParams>;

export const TagParams = z.object({
  path: z.string().describe("The path to the file to tag."),
  tag: z.string().describe("The tag to add to the file."),
});
export type TagParams = z.infer<typeof TagParams>;

// Helper function to remove the "notes/" prefix
function normalizePath(path: string): string {
  return path.startsWith("notes/") ? path.substring(6) : path;
}

// Function to create a file
export async function createFile({
  path,
  content,
}: CreateFileParams): Promise<OperationResult> {
  try {
    await client.putFileContents(`/notes/${normalizePath(path)}`, content);
    return { success: true, message: "File created successfully" };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

// Function to create a directory
export async function createDirectory({
  path,
}: CreateDirectoryParams): Promise<OperationResult> {
  try {
    await client.createDirectory(`/notes/${normalizePath(path)}`);
    return { success: true, message: "Directory created successfully" };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

// Function to delete a file or directory
export async function deleteItem({
  path,
}: DeleteItemParams): Promise<OperationResult> {
  try {
    await client.deleteFile(`/notes/${normalizePath(path)}`);
    return { success: true, message: "Deleted successfully" };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

// Function to move a file or directory
export async function moveItem({
  source_path,
  destination_path,
}: MoveItemParams): Promise<OperationResult> {
  try {
    await client.moveFile(
      `/notes/${normalizePath(source_path)}`,
      `/notes/${normalizePath(destination_path)}`
    );
    return { success: true, message: "Moved successfully" };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

// Function to search for files by name
export async function searchFilesByName({
  query,
}: SearchFilesParams): Promise<OperationResult> {
  try {
    const files = await client.getDirectoryContents("notes", {
      details: true,
      deep: true,
    });

    // If `files` is of type `ResponseDataDetailed<FileStat[]>`, you need to access the data property
    const fileList = Array.isArray(files) ? files : files.data;

    // Setup fuse.js with the filenames
    const fuse = new Fuse(fileList, {
      keys: ["filename"], // Search within filenames
      threshold: 0.3, // Adjust this to control the fuzziness (0 = exact match, 1 = very fuzzy)
    });

    const matchingFiles = fuse.search(query).map((result) => result.item);

    return {
      success: true,
      message:
        matchingFiles.length > 0
          ? matchingFiles.map((file) => file.filename).join(", ")
          : "No matching files found",
    };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

// Function to search for files by content
export async function searchFilesByContent({
  query,
}: SearchFilesParams): Promise<OperationResult> {
  try {
    const files = await client.getDirectoryContents("notes", {
      details: true,
      deep: true,
    });

    // If `files` is of type `ResponseDataDetailed<FileStat[]>`, you need to access the data property
    const fileList = Array.isArray(files) ? files : files.data;

    // First, filter files by filename using fuse.js
    const fuseFilename = new Fuse(fileList, {
      keys: ["basename"], // Search within filenames
      threshold: 0.3, // Adjust this to control the fuzziness
    });
    const matchingFilesByName = fuseFilename
      .search(query)
      .map((result) => result.item);

    const matchingFilesByContent = [];

    // Then, check file content
    for (const file of fileList) {
      if (file.type === "file") {
        const content = await client.getFileContents(file.filename, {
          format: "text",
        });
        const fuseContent = new Fuse([String(content)], {
          threshold: 0.3, // Adjust for content search
        });
        const contentMatch = fuseContent.search(query);
        if (contentMatch.length > 0) {
          matchingFilesByContent.push(normalizePath(file.filename));
        }
      }
    }

    // Combine results from filename and content search
    const combinedResults = [
      ...new Set([
        ...matchingFilesByName.map((f) => f.filename),
        ...matchingFilesByContent,
      ]),
    ];

    return {
      success: true,
      message:
        combinedResults.length > 0
          ? combinedResults.join(", ")
          : "No matching files found",
    };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

// Placeholder for tagging functionality
export async function tagFile({
  path,
  tag,
}: TagParams): Promise<OperationResult> {
  return { success: false, message: "Tagging not supported with WebDAV." };
}

// Placeholder for searching files by tag
export async function searchFilesByTag({
  tag,
}: TagParams): Promise<OperationResult> {
  return { success: false, message: "Tagging not supported with WebDAV." };
}

export async function getNotesList(): Promise<OperationResult> {
  try {
    const directoryContents = await fetchDirectoryContents("notes");

    const treeStructure = buildTree(directoryContents as any);
    return {
      success: true,
      message: JSON.stringify(treeStructure, null, 2),
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message,
    };
  }
}

async function fetchDirectoryContents(
  path: string
): Promise<ReturnType<typeof client.getDirectoryContents>> {
  let contents = await client.getDirectoryContents(path);

  // Normalize contents to always be an array of FileStat
  if (!Array.isArray(contents)) {
    contents = contents.data; // Assuming it's ResponseDataDetailed<FileStat[]>
  }

  // Recursively fetch the contents of subdirectories
  for (const item of contents) {
    if (item.type === "directory") {
      const subdirectoryContents = await fetchDirectoryContents(item.filename);
      contents = contents.concat(subdirectoryContents as any);
    }
  }

  return contents;
}

function buildTree(files: any[]): any {
  const tree: any = {};

  files.forEach((file) => {
    const parts: string[] = file.filename.replace(/^\/notes\//, "").split("/");
    let current = tree;

    parts.forEach((part, index) => {
      if (!current[part]) {
        current[part] = index === parts.length - 1 ? null : {}; // Leaf nodes are set to null
      }
      current = current[part];
    });
  });

  return tree;
}

export const FetchFileContentsParams = z.object({
  path: z
    .string()
    .describe("The path to the file whose content is to be fetched."),
});
export type FetchFileContentsParams = z.infer<typeof FetchFileContentsParams>;

// The fetchFileContents function
export async function fetchFileContents({
  path,
}: FetchFileContentsParams): Promise<OperationResult> {
  try {
    // Fetch the file content from the WebDAV server
    const fileContent: ResponseDataDetailed<string> =
      (await client.getFileContents(`/notes/${normalizePath(path)}`, {
        format: "text",
        details: true,
      })) as ResponseDataDetailed<string>;

    return {
      success: true,
      message: fileContent,
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message,
    };
  }
}

export const UpdateFileParams = z.object({
  path: z.string().describe("The path to the note file to be updated."),
  new_content: z
    .string()
    .describe("The new content to replace the existing content."),
});
export type UpdateFileParams = z.infer<typeof UpdateFileParams>;

export async function updateNote({
  path,
  new_content,
}: UpdateFileParams): Promise<OperationResult> {
  try {
    // Fetch the existing content to ensure the file exists and to avoid overwriting unintentionally
    const existingContent = await client.getFileContents(
      `/notes/${normalizePath(path)}`,
      {
        format: "text",
      }
    );

    // Update the file with the new content
    await client.putFileContents(`/notes/${normalizePath(path)}`, new_content);

    return { success: true, message: "Note updated successfully" };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

// Integration into runnable tools
export let webdav_tools: RunnableToolFunction<any>[] = [
  zodFunction({
    function: getNotesList,
    name: "getNotesList",
    schema: z.object({}),
    description: "Get the list of note files and directories.",
  }),
  zodFunction({
    function: fetchFileContents,
    name: "fetchNoteFileContents",
    schema: FetchFileContentsParams,
    description: "Fetch the contents of a specific note file.",
  }),
  zodFunction({
    function: createFile,
    name: "createNoteFile",
    schema: CreateFileParams,
    description: "Create a new note file.",
  }),
  zodFunction({
    function: updateNote,
    name: "updateNote",
    schema: UpdateFileParams,
    description: "Update an existing note.",
  }),
  zodFunction({
    function: createDirectory,
    name: "createNoteDir",
    schema: CreateDirectoryParams,
    description: "Create a new directory in notes.",
  }),
  zodFunction({
    function: deleteItem,
    name: "deleteNoteItem",
    schema: DeleteItemParams,
    description: "Delete a note file or directory.",
  }),
  zodFunction({
    function: moveItem,
    name: "moveNote",
    schema: MoveItemParams,
    description: "Move a note file or directory.",
  }),
  // zodFunction({
  //   function: searchFilesByName,
  //   name: "searchNotesFilesByName",
  //   schema: SearchFilesParams,
  //   description: "Search notes by filename.",
  // }),
  zodFunction({
    function: searchFilesByContent,
    name: "searchNotesFilesByContent",
    schema: SearchFilesParams,
    description: "Search notes by content.",
  }),
  zodFunction({
    function: tagFile,
    name: "tagNoteFile",
    schema: TagParams,
    description: "Add a tag to a note file.",
  }),
  // zodFunction({
  //   function: searchFilesByTag,
  //   name: "searchNotesFilesByTag",
  //   schema: TagParams,
  //   description: "Search notes by tag.",
  // }),
];

export function getNotesSystemPrompt() {
  return `The notes system manages a structured file system for organizing and retrieving notes using Nextcloud via WebDAV. All notes are stored in the 'notes' directory, with subdirectories for different content types.

**Key Directories:**

- **Root**: Contains a 'readme' summarizing the structure.
- **Journal**: Logs daily events and activities. Subdirectories include:
  - **general**: General daily events or notes.
  - **standup**: Work-related standup notes. Filenames should be dates in YYYY-MM-DD format.
  - **personal**: Personal life events, same format as standup notes.
  - **gym**: Gym or workout activities.

- **Lists**: Contains lists of items or tasks. Subdirectories can organize different list types.

**Standup and Personal Note Template:**

- **Filename**: Date in YYYY-MM-DD format.
- **Title**: Human-readable date (e.g., "Thursday 15th of July"), year not necessary.
- **Updates Section**: List of updates describing the day's events.
- **Summary Section**: A summary of the main points.

**Gym Note Template:**

- **Filename**: Date in YYYY-MM-DD format.
- **Title**: Gym day and date (e.g., "Pull Day - Thursday 15th of July").
- **Activity**: Exercises performed, sets, reps, weights.
- **Progress Report**: Progress updates, achievements, challenges, comparisons with previous workouts, suggestions for improvement.

**Lists Template:**

- **Directory Structure**: Create subdirectories within 'lists' for different types (e.g., 'shows', 'movies', 'shopping').
- **Filename**: Each file represents a list item with context. For 'shopping', use a single file like 'shopping.md'.

**Functionality:**

- Create, update, delete and move notes by filename or content.
- The \`updateNote\` function modifies existing notes.

This system ensures efficient note management, avoiding duplication, maintaining organization, and following structured templates for work and personal notes.`;
}

export const NotesManagerParams = z.object({
  request: z.string().describe("User's request regarding notes."),
});
export type NotesManagerParams = z.infer<typeof NotesManagerParams>;

export async function notesManager(
  { request }: NotesManagerParams,
  context_message: Message
) {
  const tools = webdav_tools.concat(
    memory_manager_init(context_message, "notes_manager")
  );
  const response = await ask({
    model: "gpt-4o",
    prompt: `You are a notes manager for the 'notes' directory in Nextcloud.

Your job is to understand the user's request (e.g., create, update, delete, move, list) and handle it using the available tools. Ensure the 'notes' directory remains organized, filenames and paths are correct, and duplication is prevented.

Avoid running \`fetchNoteFileContents\` unnecessarily, as it fetches the entire file content and is resource-intensive.

**More about the Notes System:**

${getNotesSystemPrompt()}

Follow the above guidelines to manage notes efficiently.

----

${memory_manager_guide("notes_manager")}

----

**Live Values:**

- **Today's Date:** ${new Date().toDateString()}
- **Current Notes List:**
${(await getNotesList()).message}
    `,
    message: request,
    seed: `notes-${context_message.channelId}`,
    tools: tools as any,
  });

  return { response };
}
