import path from "path";
import { notesManager } from "./notes";
import { getNotesList, fetchFileContents } from "./notes";
import { discordAdapter } from "../interfaces";
import { userConfigs } from "../config";
import { eventManager } from "../interfaces/events";

// Watcher interval in milliseconds (2 minutes)
const WATCH_INTERVAL = 1 * 60 * 1000;

// Function to check the notes for changes
async function watchNotes() {
  console.log("Watching notes for changes...");
  try {
    const notesListResult = await getNotesList();
    if (!notesListResult.success) {
      console.error("Failed to fetch notes list: ", notesListResult.message);
      return;
    }

    const notesList = JSON.parse(String(notesListResult.message));
    const flatFileList = flattenNotesTree(notesList);

    for (const filePath of flatFileList) {
      const fileContentResult = await fetchFileContents({ path: filePath });
      if (!fileContentResult.success) {
        console.error("Failed to fetch file contents for ", filePath);
        continue;
      }

      const fileContent = fileContentResult.message.toString();
      const lines = fileContent.split("\n");

      for (const line of lines) {
        if (line.startsWith("!!")) {
          console.log("Found instruction in file: ", filePath);
          const instruction = line.substring(2).trim();
          await handleNoteInstruction(filePath, fileContent, instruction);
          break; // Only process the first !! line per file
        }
      }
    }
  } catch (error) {
    console.error("Error watching notes: ", error);
  }
}

// Helper function to flatten the notes tree structure into a list of file paths
function flattenNotesTree(tree: any, currentPath: string = ""): string[] {
  let fileList: string[] = [];
  for (const key in tree) {
    if (tree[key] === null) {
      fileList.push(path.join(currentPath, key));
    } else {
      fileList = fileList.concat(
        flattenNotesTree(tree[key], path.join(currentPath, key))
      );
    }
  }
  return fileList;
}

// Function to handle the note instruction
async function handleNoteInstruction(
  filePath: string,
  fileContent: string,
  instruction: string
) {
  try {
    const creator = userConfigs.find((u) => u.roles.includes("creator"));
    const creator_discord_id = creator?.identities.find(
      (i) => i.platform === "discord"
    )?.id;
    if (!creator_discord_id) {
      console.error("Creator discord id not found in user configs");
      return;
    }
    const context_message = await discordAdapter.createMessageInterface(
      creator_discord_id
    );
    const response = await notesManager(
      {
        request: `The following is a note that the user left a message for you in.
        The file path is: ${filePath}
        The user's instruction for you is in the file content and starts with '!!' followed by the message or a attached audio message that you can Transcribe to get the actual instructions.

        Note: Make sure to remove the user's instruction line (line that starts with '!!') and the respective audio message if there is one after you have read it and done the necessary action.

        file content:
        ${fileContent}
        `,
      },
      context_message
    );

    console.log(
      `Handled instruction for file: ${filePath}. Response:`,
      response.response
    );
    response.response.choices[0].message.content?.toString() &&
      (await context_message.send({
        content: response.response.choices[0].message.content?.toString(),
      }));
  } catch (error) {
    console.error(
      `Failed to handle note instruction for file: ${filePath}`,
      error
    );
  }
}

// Start the watcher
export function init_notes_watcher() {
  setInterval(async () => {
    console.time("watchNotes");
    await watchNotes();
    console.timeEnd("watchNotes");
  }, WATCH_INTERVAL);
}

console.log("Started watching notes for changes every 2 minutes...");

// Watcher for notes with "to anya" in the last non-empty line
async function watchAnyaTodos() {
  console.log("Watching notes for 'to anya' instructions...");
  try {
    const notesListResult = await getNotesList();

    if (!notesListResult.success) {
      console.error("Failed to fetch notes list: ", notesListResult.message);
      return;
    }

    const notesList = JSON.parse(String(notesListResult.message));
    const flatFileList = flattenNotesTree(notesList);

    for (const filePath of flatFileList) {
      const fileContentResult = await fetchFileContents({ path: filePath });
      if (!fileContentResult.success) {
        console.error("Failed to fetch file contents for ", filePath);
        continue;
      }

      const fileContent = fileContentResult.message.toString();
      const lines = fileContent
        .split("\n")
        .filter((line) => line.trim() !== "");
      if (lines.length === 0) {
        continue;
      }

      // check if the obsidian note has a tag called "to-anya"
      const is_tagged = lines.some((line) => line.includes("#to-anya"));
      // check if any of the lines contains the string "[ ]" in the 1st 50% of the line. If it does, then return true, else return false
      const has_undone_todos = lines.some((line) => {
        const half_line = line.slice(0, Math.floor(line.length / 2));
        return half_line.includes("[ ]");
      });

      if (is_tagged && has_undone_todos) {
        console.log("Found 'to anya' instruction in file: ", filePath);
        if (!fileContent.includes("[FAILED]")) {
          await eventManager.emitWithResponse("new_todo_for_anya", {
            note_path: filePath,
            note_content: fileContent,
          });
        }
      }
    }
  } catch (error) {
    console.error("Error watching notes for 'to anya': ", error);
  }
}

// Start the watcher for notes with "to anya" instructions
export function init_anya_todos_watcher() {
  let isRunning = false;

  setInterval(async () => {
    if (!isRunning) {
      isRunning = true;
      console.time("watchAnyaTodos");
      await watchAnyaTodos();
      console.timeEnd("watchAnyaTodos");
      isRunning = false;
    }
  }, WATCH_INTERVAL);
}

console.log("Started watching notes for 'to anya' instructions...");
