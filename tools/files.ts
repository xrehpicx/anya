import { Client } from "minio";
import { z } from "zod";

if (!process.env.MINIO_ACCESS_KEY || !process.env.MINIO_SECRET_KEY) {
  throw new Error(
    "MINIO_ACCESS_KEY or MINIO_SECRET_KEY not found in environment variables"
  );
}

// Initialize MinIO client
const minioClient = new Client({
  endPoint: "s3.raj.how",
  port: 443,
  useSSL: true,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});

// Define schema for uploading file
export const UploadFileParams = z.object({
  bucketName: z.string().default("public").optional(),
  fileName: z.string().describe("make sure this is unique"),
  filePath: z
    .string()
    .describe(
      "put all files inside 'anya' directory by default unless user specifies otherwise"
    ),
});
export type UploadFileParams = z.infer<typeof UploadFileParams>;

// Define schema for getting file list
export const GetFileListParams = z.object({
  bucketName: z.string().default("public").optional(),
});
export type GetFileListParams = z.infer<typeof GetFileListParams>;

// Upload file to MinIO bucket and return public URL
export async function upload_file({
  bucketName = "public",
  fileName,
  filePath,
}: UploadFileParams) {
  try {
    await minioClient.fPutObject(bucketName, fileName, filePath);
    const publicUrl = `https://s3.raj.how/${bucketName}/${fileName}`;
    return {
      publicUrl,
    };
  } catch (error) {
    return {
      error: JSON.stringify(error),
    };
  }
}

// Get list of all files in the bucket and return their public URLs
export async function get_file_list({
  bucketName = "public",
}: GetFileListParams) {
  try {
    const fileUrls: string[] = [];
    const stream = await minioClient.listObjects(bucketName, "", true);

    for await (const obj of stream) {
      const fileUrl = `https://s3.raj.how/${bucketName}/${obj.name}`;
      fileUrls.push(fileUrl);
    }

    return fileUrls;
  } catch (error) {
    return {
      error: JSON.stringify(error),
    };
  }
}
