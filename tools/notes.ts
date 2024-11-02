import { createClient, FileStat, ResponseDataDetailed } from "webdav";
import { z } from "zod";
import { zodFunction } from ".";
import { RunnableToolFunction } from "openai/lib/RunnableFunction.mjs";
import Fuse from "fuse.js";
import { ask, get_transcription } from "./ask";
import { Message } from "../interfaces/message";
import { memory_manager_guide, memory_manager_init } from "./memory-manager";
import {
  getClusteredFiles,
  semantic_search_notes,
  syncVectorStore,
} from "./notes-vectors";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { message_anya_tool } from "./message-anya";

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
  tag: z.string().describe("The tag to add to the file."),
});
export type TagParams = z.infer<typeof TagParams>;

export const FetchFileContentsParams = z.object({
  path: z
    .string()
    .describe("The path to the file whose content is to be fetched."),
});
export type FetchFileContentsParams = z.infer<typeof FetchFileContentsParams>;

export const UpdateFileParams = z.object({
  path: z.string().describe("The path to the note file to be updated."),
  new_content: z
    .string()
    .describe("The new content to replace the existing content."),
});
export type UpdateFileParams = z.infer<typeof UpdateFileParams>;

export const NotesManagerParams = z.object({
  request: z.string().describe("User's request regarding notes."),
});
export type NotesManagerParams = z.infer<typeof NotesManagerParams>;

export const SemanticSearchNotesParams = z.object({
  query: z
    .string()
    .describe(
      "The query to search for semantically similar notes, this can be something some content or even file name."
    ),
});

type SemanticSearchNotesParams = z.infer<typeof SemanticSearchNotesParams>;

async function semanticSearchNotes({
  query,
}: SemanticSearchNotesParams): Promise<OperationResult> {
  try {
    const results = await semantic_search_notes(query, 4);
    return {
      success: true,
      message: results.map((r) => r.pageContent),
    };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

const GetClusteredFileListParams = z.object({});
type GetClusteredFileListParams = z.infer<typeof GetClusteredFileListParams>;

export async function getClusteredFileList({}: GetClusteredFileListParams): Promise<OperationResult> {
  try {
    const results = await getClusteredFiles();
    return {
      success: true,
      message: JSON.stringify(results, null, 2),
    };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

// Helper function to normalize paths
function normalizePath(path: string): string {
  if (path.startsWith("/notes/")) return path.substring(7);
  if (path.startsWith("notes/")) return path.substring(6);
  if (path === "/notes" || path === "notes") return "";
  return path;
}

// File and directory operations
export async function createFile({
  path,
  content,
}: CreateFileParams): Promise<OperationResult> {
  try {
    await client.putFileContents(`/notes/${normalizePath(path)}`, content);
    await syncVectorStore();
    return { success: true, message: "File created successfully" };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

export async function createDirectory({
  path,
}: CreateDirectoryParams): Promise<OperationResult> {
  try {
    await client.createDirectory(`/notes/${normalizePath(path)}`);
    await syncVectorStore();
    return { success: true, message: "Directory created successfully" };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

export async function deleteItem({
  path,
}: DeleteItemParams): Promise<OperationResult> {
  try {
    await client.deleteFile(`/notes/${normalizePath(path)}`);
    await syncVectorStore();
    return { success: true, message: "Deleted successfully" };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

export async function moveItem({
  source_path,
  destination_path,
}: MoveItemParams): Promise<OperationResult> {
  try {
    await client.moveFile(
      `/notes/${normalizePath(source_path)}`,
      `/notes/${normalizePath(destination_path)}`
    );
    await syncVectorStore();
    return { success: true, message: "Moved successfully" };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

// Search functions
export async function searchFilesByContent({
  query,
}: SearchFilesParams): Promise<OperationResult> {
  try {
    const files = await client.getDirectoryContents("notes", {
      details: true,
      deep: true,
    });

    const fileList = Array.isArray(files) ? files : files.data;
    const matchingFiles: string[] = [];

    // Search by filename using Fuse.js
    const fuseFilename = new Fuse(fileList, {
      keys: ["basename"],
      threshold: 0.3,
    });
    const matchingFilesByName = fuseFilename
      .search(query)
      .map((result) => result.item.filename);

    // Search by file content
    for (const file of fileList) {
      if (file.type === "file") {
        const content = await client.getFileContents(file.filename, {
          format: "text",
        });
        if (typeof content === "string" && content.includes(query)) {
          matchingFiles.push(normalizePath(file.filename));
        }
      }
    }

    // Combine and deduplicate results
    const combinedResults = [
      ...new Set([...matchingFilesByName, ...matchingFiles]),
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

export async function searchFilesByTag({ tag }: TagParams) {
  const files = await client.getDirectoryContents("notes", {
    details: true,
    deep: true,
  });

  const fileList = Array.isArray(files) ? files : files.data;
  const matchingFiles: Array<{ filename: string; content: string }> = [];

  for (const file of fileList) {
    if (file.type === "file") {
      const fileContent = await client.getFileContents(file.filename, {
        format: "text",
      });
      if (typeof fileContent === "string" && fileContent.includes(tag)) {
        matchingFiles.push({ filename: file.filename, content: fileContent });
      }
    }
  }

  return matchingFiles;
}

// Notes list caching
let cachedNotesList: string | null = null;
let lastFetchTime: number | null = null;

export async function getNotesList(): Promise<OperationResult> {
  try {
    const currentTime = Date.now();
    if (
      cachedNotesList &&
      lastFetchTime &&
      currentTime - lastFetchTime < 5000
    ) {
      return { success: true, message: cachedNotesList };
    }

    const directoryContents = await fetchDirectoryContents("notes");
    const treeStructure = buildTree(directoryContents);
    cachedNotesList = JSON.stringify(treeStructure, null, 2);
    lastFetchTime = currentTime;

    return { success: true, message: cachedNotesList };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

async function fetchDirectoryContents(path: string): Promise<FileStat[]> {
  let contents = await client.getDirectoryContents(path);

  // Normalize contents to always be an array of FileStat
  if (!Array.isArray(contents)) {
    contents = contents.data; // Assuming it's ResponseDataDetailed<FileStat[]>
  }

  // Recursively fetch the contents of subdirectories
  for (const item of contents) {
    if (item.type === "directory") {
      const subdirectoryContents = await fetchDirectoryContents(item.filename);
      contents = contents.concat(subdirectoryContents);
    }
  }

  return contents;
}

function buildTree(files: any[]): any {
  const tree: any = {};

  files.forEach((file) => {
    const parts: string[] = file.filename.replace(/^\/notes\//, "").split("/");

    // Ignore files inside dot folders
    if (parts.some((part) => part.startsWith(".obsidian"))) {
      return;
    }

    let current = tree;

    parts.forEach((part, index) => {
      if (!current[part]) {
        current[part] = index === parts.length - 1 ? null : {};
      }
      current = current[part];
    });
  });

  return tree;
}

// File content operations
export async function fetchFileContents({
  path,
}: FetchFileContentsParams): Promise<OperationResult> {
  try {
    const fileContent = await client.getFileContents(
      `/notes/${normalizePath(path)}`,
      { format: "text", details: true }
    );

    if (typeof fileContent === "string") {
      // Should not happen when details is true
      return { success: true, message: fileContent };
    } else if ("data" in fileContent) {
      return { success: true, message: fileContent.data };
    } else {
      return {
        success: false,
        message: "Unexpected response format from getFileContents.",
      };
    }
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

export async function updateNote({
  path,
  new_content,
}: UpdateFileParams): Promise<OperationResult> {
  try {
    await client.putFileContents(`/notes/${normalizePath(path)}`, new_content);
    await syncVectorStore();
    return { success: true, message: "Note updated successfully" };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

// Caching for tag-based searches
let cachedFiles: Array<{ filename: string; content: string }> | null = null;
let isUpdatingCache = false;

export async function searchFilesByTagWithCache({ tag }: TagParams) {
  if (cachedFiles) {
    if (!isUpdatingCache) {
      console.log("Updating cache");
      setTimeout(() => updateCache(tag), 0);
    }
    return cachedFiles;
  }

  cachedFiles = await updateCache(tag);
  return cachedFiles;
}

async function updateCache(
  tag: string
): Promise<Array<{ filename: string; content: string }>> {
  if (isUpdatingCache) {
    return cachedFiles || [];
  }

  isUpdatingCache = true;
  const files = await client.getDirectoryContents("notes", {
    details: true,
    deep: true,
  });

  const fileList = Array.isArray(files) ? files : files.data;
  const matchingFiles: Array<{ filename: string; content: string }> = [];

  for (const file of fileList) {
    if (
      file.type === "file" &&
      (file.filename.endsWith(".md") || file.filename.endsWith(".txt"))
    ) {
      const fileContent = await client.getFileContents(file.filename, {
        format: "text",
      });
      if (typeof fileContent === "string" && fileContent.includes(tag)) {
        matchingFiles.push({ filename: file.filename, content: fileContent });
      }
    }
  }

  cachedFiles = matchingFiles;
  isUpdatingCache = false;
  return matchingFiles;
}

// Notes manager integration
export async function notesManager(
  { request }: NotesManagerParams,
  context_message: Message
) {
  const notesManagerPromptFiles = await searchFilesByTagWithCache({
    tag: "#notes-manager",
  });

  const tools = webdav_tools.concat(
    memory_manager_init(context_message, "notes_manager")
  );

  const potentially_relavent_files = await semantic_search_notes(request, 4);
  const potentially_relavent_files_paths = potentially_relavent_files.map(
    (f) => f.metadata.filename
  );

  const response = await ask({
    model: "gpt-4o",
    prompt: `You are an Obsidian vault manager.

Ensure the vault remains organized, filenames and paths are correct, and relavent files are linked to each other.
You can try creating canvas files that use the open json canvas format

- **Today's Date:** ${new Date().toDateString()}
- **Current Time:** ${new Date().toLocaleTimeString()}

You also have access to message_anya tool that can ask an ai called Anya for help with scheduling notifications reminders or even calender events for the user, you can also fetch details about the same by asking her.

- **ALL Vault's File structure for context:**
---
${(await getNotesList()).message}
---
${
  potentially_relavent_files_paths.length > 0
    ? `
- **Potentially relevant files:**

You can use these files to get more context or to link to the notes you are creating/updating.

---
${potentially_relavent_files_paths.join("\n")}
---`
    : ""
}

- **Recently Modified Files:**
---
${(await getRecentFiles({})).message}
---

- **User Notes/Instructions for you:** 
---
${notesManagerPromptFiles.map((f) => f.content).join("\n")}
---

- **Current User's Home page (quick-note.md):** 
---
${
  (
    await fetchFileContents({
      path: "quick-note.md",
    })
  ).message
}

Note: When the user is trying to create/add a note, check the templates directory for any relevant templates if available. If available, fetch the relevant template and create the note based on the template.
    `,
    message: request,
    seed: `notes-${context_message.channelId}`,
    tools: tools as any,
  });

  return { response };
}

// Schema for the transcription function parameters
export const TranscriptionParams = z.object({
  file_path: z
    .string()
    .describe("The path to the audio file to be transcribed."),
});
export type TranscriptionParams = z.infer<typeof TranscriptionParams>;

// Tool for handling transcription requests
export async function transcribeAudioFile({
  file_path,
}: TranscriptionParams): Promise<OperationResult> {
  try {
    // Download the audio file from WebDAV
    const audioFileBuffer = await client.getFileContents(
      `/notes/${normalizePath(file_path)}`,
      {
        format: "binary",
      }
    );

    if (!Buffer.isBuffer(audioFileBuffer)) {
      throw new Error("Failed to download audio file as Buffer.");
    }

    // Convert the Buffer to a base64 string
    const audioFileBase64 = audioFileBuffer.toString("base64");

    // Transcribe the audio file
    const transcription = await get_transcription(
      audioFileBase64,
      true,
      file_path
    );
    return {
      success: true,
      message: transcription,
    };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

export async function getRecentFiles({}): Promise<OperationResult> {
  const limit = 5;
  try {
    const files = await client.getDirectoryContents("notes", {
      details: true,
      deep: true,
    });

    const fileList = Array.isArray(files) ? files : files.data;
    const sortedFiles = fileList
      .filter((file) => file.type === "file")
      .sort((a, b) => {
        const aTime = new Date(a.lastmod).getTime();
        const bTime = new Date(b.lastmod).getTime();
        return bTime - aTime;
      });

    const latestFiles = sortedFiles
      .slice(0, limit)
      .map((file) => file.filename);

    return {
      success: true,
      message: latestFiles.length > 0 ? latestFiles : "No files found",
    };
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
    function: transcribeAudioFile,
    name: "transcribeAudioFile",
    schema: TranscriptionParams,
    description:
      "Transcribe an audio file specified by the provided file path.",
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
  message_anya_tool("message_from_notes_manager"),
  zodFunction({
    function: semanticSearchNotes,
    name: "semanticSearchNotes",
    schema: SemanticSearchNotesParams,
    description: `Search notes by their semantically.

You can use this to search by:
1. Topic
2. Content
3. File Name
4. Tags
`,
  }),
  zodFunction({
    function: getClusteredFileList,
    name: "getClusteredFileList",
    schema: GetClusteredFileListParams,
    description: `Get the list of notes files based on 4 cluster (unsupervised) semantic clustering.
    You can use this to see how the notes are clustered based on their content.
    `,
  }),
];
