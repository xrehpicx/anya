import { Client } from "pg";
import skmeans from "skmeans";

const config = {
  postgresConnectionOptions: {
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
  },
};

// Fetch embeddings from PostgreSQL with data inspection
async function fetchEmbeddings(): Promise<{ id: string; vector: number[] }[]> {
  const client = new Client(config.postgresConnectionOptions);
  await client.connect();

  const res = await client.query(
    `SELECT ${config.columns.idColumnName} as id, ${config.columns.vectorColumnName} as vector 
     FROM ${config.tableName} LIMIT 5`
  );
  await client.end();

  // Inspect the data format of each vector
  return res.rows.map((row, index) => {
    console.log(`Row ${index} - Vector Type:`, typeof row.vector);
    console.log(`Row ${index} - Vector Data:`, row.vector);

    let vector: number[] = [];

    // Determine the correct format based on observed type
    if (Array.isArray(row.vector)) {
      vector = row.vector; // If it's already an array, use as-is
    } else if (typeof row.vector === "string") {
      vector = JSON.parse(row.vector); // If string, parse as JSON
    } else if (Buffer.isBuffer(row.vector)) {
      vector = Array.from(row.vector); // If Buffer, convert to array of numbers
    } else {
      console.error("Unknown vector format:", row.vector);
    }

    return {
      id: row.id,
      vector,
    };
  });
}

// Run clustering on fetched embeddings
async function listClusters() {
  const embeddings = await fetchEmbeddings();
  const vectors = embeddings.map((doc) => doc.vector);

  // Validate the format and contents of the vectors
  vectors.forEach((vector, index) => {
    if (!Array.isArray(vector) || vector.some(isNaN)) {
      console.error(`Invalid vector at index ${index}:`, vector);
    }
  });

  // Run K-means clustering with a specified number of clusters
  const k = 3; // Number of clusters
  const result = skmeans(vectors, k);

  // Log the cluster assignment for each document
  embeddings.forEach((doc, index) => {
    console.log(`Document ID: ${doc.id}, Cluster: ${result.idxs[index]}`);
  });

  console.log("Cluster assignments:", result.idxs);
}

// Execute clustering function
listClusters().catch(console.error);
