import { createClient } from "webdav";
import {
  PGVectorStore,
  DistanceStrategy,
} from "@langchain/community/vectorstores/pgvector";
import { OpenAIEmbeddings } from "@langchain/openai";
import { v4 as uuidv4 } from "uuid";
import * as crypto from "crypto";
import skmeans from "skmeans";

let isSyncing = false;
let isCleanupRunning = false;

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
      !file.filename.includes("prompts/") &&
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
    clusterColumnName: "cluster",
  },
  distanceStrategy: "cosine" as DistanceStrategy,
};

const vectorStore = await PGVectorStore.initialize(embeddings, config);

const CLUSTER_COUNT = 4;

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

    let filesIndexed = 0;

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
      filesIndexed++;
      console.log(`Indexed ${file.filename}`);
    }
    filesIndexed > 0 && (await runClustering());
    console.log("Vector store sync completed.");
  } catch (error) {
    console.error("Error during vector store sync:", error);
  } finally {
    isSyncing = false;
  }
}

// Function to remove deleted files from vector store
export async function cleanupDeletedFiles() {
  if (isCleanupRunning) {
    console.log("cleanupDeletedFiles is already running. Skipping this run.");
    return;
  }

  isCleanupRunning = true;
  try {
    console.log("Starting cleanup of deleted files...");

    // Get the list of all files in the vector store
    const queryResult = await vectorStore.client?.query(
      `SELECT metadata->>'filename' AS filename, id FROM ${config.tableName}`
    );

    if (queryResult) {
      const dbFiles = queryResult.rows;
      const files = await getAllFiles("notes");
      const existingFilenames = files.map((file) => file.filename);
      let deletedFiles = 0;

      for (const dbFile of dbFiles) {
        if (!existingFilenames.includes(dbFile.filename)) {
          // Delete the file from the vector store if it no longer exists in notes
          await vectorStore.delete({ ids: [dbFile.id] });
          deletedFiles++;
          console.log(
            `Deleted ${dbFile.filename} from vector store as it no longer exists.`
          );
        }
      }
      deletedFiles > 0 && (await runClustering());
    }

    console.log("Cleanup of deleted files completed.");
  } catch (error) {
    console.error("Error during cleanup of deleted files:", error);
  } finally {
    isCleanupRunning = false;
  }
}

// Ensure the cluster column exists in the table
async function ensureClusterColumn() {
  await vectorStore.client?.query(
    `ALTER TABLE ${config.tableName} ADD COLUMN IF NOT EXISTS ${config.columns.clusterColumnName} INT;`
  );
  console.log("Ensured cluster column exists in the database.");
}

// Function to generate clusters from stored embeddings and save them to the database
async function generateClusters(k: number) {
  // Ensure the cluster column exists before proceeding
  await ensureClusterColumn();

  const queryResult = await vectorStore.client?.query(
    `SELECT ${config.columns.idColumnName} as id, ${config.columns.vectorColumnName} as vector
     FROM ${config.tableName}`
  );

  if (!queryResult) {
    console.log("No embeddings found in the vector store.");
    return;
  }

  // Process embeddings and format data
  const embeddings = queryResult.rows.map((row) => {
    let vector: number[] = [];

    // Check vector data format and convert to number array if needed
    if (Array.isArray(row.vector)) {
      vector = row.vector;
    } else if (typeof row.vector === "string") {
      vector = JSON.parse(row.vector);
    } else if (Buffer.isBuffer(row.vector)) {
      vector = Array.from(row.vector);
    } else {
      console.error("Unknown vector format:", row.vector);
    }

    return {
      id: row.id,
      vector,
    };
  });

  // Extract vectors for clustering
  const vectors = embeddings.map((doc) => doc.vector);

  // Run clustering algorithm (K-means)
  const result = skmeans(vectors, k);

  // Save each document’s cluster label in the database
  for (const [index, doc] of embeddings.entries()) {
    const cluster = result.idxs[index];
    await vectorStore.client?.query(
      `UPDATE ${config.tableName} SET ${config.columns.clusterColumnName} = $1 WHERE ${config.columns.idColumnName} = $2`,
      [cluster, doc.id]
    );
    console.log(`Document ID: ${doc.id} assigned to Cluster: ${cluster}`);
  }

  console.log("Cluster assignments saved to database.");
}

// Exported function to run clustering
export async function runClustering() {
  const k = CLUSTER_COUNT;
  console.log("Generating clusters...");
  await generateClusters(k);
}

export async function initVectorStoreSync() {
  console.log("Starting vector store sync...");
  await syncVectorStore();
  setInterval(syncVectorStore, 1000 * 60 * 2); // Every 2 minutes
  await cleanupDeletedFiles();
  setInterval(cleanupDeletedFiles, 1000 * 60 * 60 * 2); // Every 12 hours
}

export function semantic_search_notes(query: string, limit: number) {
  return vectorStore.similaritySearch(query, limit);
}
