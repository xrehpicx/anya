import { createClient } from "webdav";
import {
  PGVectorStore,
  DistanceStrategy,
} from "@langchain/community/vectorstores/pgvector";
import { OpenAIEmbeddings } from "@langchain/openai";
import { v4 as uuidv4 } from "uuid";
import * as crypto from "crypto";

let isSyncing = false;

// Initialize WebDAV client
const webdavClient = createClient(
  "http://192.168.29.85/remote.php/dav/files/raj/",
  {
    username: process.env.NEXTCLOUD_USERNAME!,
    password: process.env.NEXTCLOUD_PASSWORD!,
  }
);

// Helper function to calculate checksum of content
function calculateChecksum(content: string): string {
  return crypto.createHash("md5").update(content, "utf8").digest("hex");
}

// Function to get all files from 'notes' directory via WebDAV
async function getAllFiles(
  path: string
): Promise<{ filename: string; content: string }[]> {
  const contents = await webdavClient.getDirectoryContents(path, {
    deep: true,
  });

  const files = Array.isArray(contents) ? contents : contents.data;

  const fileContents: { filename: string; content: string }[] = [];

  for (const file of files) {
    if (
      file.type === "file" &&
      !file.basename.startsWith(".") &&
      !file.filename.includes("/.obsidian/") &&
      (file.filename.endsWith(".txt") || file.filename.endsWith(".md"))
    ) {
      const content = await webdavClient.getFileContents(file.filename, {
        format: "text",
      });
      if (typeof content === "string") {
        fileContents.push({ filename: file.filename, content });
      }
    }
  }

  return fileContents;
}

// Setup PGVectorStore
const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-ada-002",
});

const config = {
  postgresConnectionOptions: {
    type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    user: "postgres",
    password: "defaultpwd",
    database: "postgres",
  },
  tableName: "anya",
  columns: {
    idColumnName: "id",
    vectorColumnName: "vector",
    contentColumnName: "content",
    metadataColumnName: "metadata",
  },
  distanceStrategy: "cosine" as DistanceStrategy,
};

const vectorStore = await PGVectorStore.initialize(embeddings, config);
// Main function to sync vector store
export async function syncVectorStore() {
  if (isSyncing) {
    console.log("syncVectorStore is already running. Skipping this run.");
    return;
  }

  isSyncing = true;
  try {
    console.log("Starting vector store sync...");
    const files = await getAllFiles("notes");

    for (const file of files) {
      const content = `filename: ${file.filename}\n${file.content}`;
      // Calculate checksum
      const checksum = calculateChecksum(content);

      // Check if the document already exists using direct SQL query
      const queryResult = await vectorStore.client?.query(
        `SELECT * FROM ${config.tableName} WHERE metadata->>'filename' = $1`,
        [file.filename]
      );

      if (queryResult && queryResult.rows.length > 0) {
        const existingDocument = queryResult.rows[0];
        const existingChecksum = existingDocument.metadata?.checksum;

        // If the checksum matches, skip updating
        if (existingChecksum === checksum) {
          // console.log(`Skipping ${file.filename}, checksum unchanged.`);
          continue;
        }

        // If the content is different, delete the old version
        await vectorStore.delete({ ids: [existingDocument.id] });
        console.log(`Deleted old version of ${file.filename}`);
      }

      // Load the document
      const document = {
        pageContent: content,
        metadata: { checksum, filename: file.filename, id: uuidv4() },
      };

      // Add or update the document in the vector store
      await vectorStore.addDocuments([document], {
        ids: [document.metadata.id],
      });

      console.log(`Indexed ${file.filename}`);
    }

    console.log("Vector store sync completed.");
  } catch (error) {
    console.error("Error during vector store sync:", error);
  } finally {
    isSyncing = false;
  }
}

export async function initVectorStoreSync() {
  console.log("Starting vector store sync...");
  await syncVectorStore();
  setInterval(syncVectorStore, 1000 * 60 * 2); // Every 2 minutes
}

export function semantic_search_notes(query: string, limit: number) {
  return vectorStore.similaritySearch(query, limit);
}
