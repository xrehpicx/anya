import * as fs from "fs";
import * as path from "path";
import { pathInDataDir } from "./config";

// Define interfaces
interface ApiUsage {
  date: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface UsageMetrics {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  model: string;
}

// Define the directory for storage
const STORAGE_DIR = pathInDataDir("apiUsageData");

// Ensure the storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR);
}

// Function to get the file path for a specific date
function getFilePath(date: string): string {
  return path.join(STORAGE_DIR, `${date}.json`);
}

// Function to read data from a file
function readDataFromFile(filePath: string): ApiUsage[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const rawData = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(rawData) as ApiUsage[];
}

// Function to write data to a file
function writeDataToFile(filePath: string, data: ApiUsage[]): void {
  const jsonData = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, jsonData, "utf-8");
}

// Function to save API usage data
function saveApiUsage(
  date: string,
  model: string,
  promptTokens: number,
  completionTokens: number
): void {
  const filePath = getFilePath(date);
  let apiUsageData = readDataFromFile(filePath);
  let existingData = apiUsageData.find((usage) => usage.model === model);

  if (existingData) {
    existingData.promptTokens += promptTokens;
    existingData.completionTokens += completionTokens;
    existingData.totalTokens += promptTokens + completionTokens;
  } else {
    apiUsageData.push({
      date,
      model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    });
  }

  writeDataToFile(filePath, apiUsageData);
}

// Function to calculate usage metrics based on a date range
function getTotalUsage(fromDate: string, toDate: string): UsageMetrics[] {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  let usageMetrics: { [model: string]: UsageMetrics } = {};

  for (let d = from; d <= to; d.setDate(d.getDate() + 1)) {
    const filePath = getFilePath(d.toISOString().split("T")[0]);
    const dailyUsage = readDataFromFile(filePath);

    dailyUsage.forEach((usage) => {
      if (!usageMetrics[usage.model]) {
        usageMetrics[usage.model] = {
          model: usage.model,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalTokens: 0,
        };
      }

      usageMetrics[usage.model].totalPromptTokens += usage.promptTokens;
      usageMetrics[usage.model].totalCompletionTokens += usage.completionTokens;
      usageMetrics[usage.model].totalTokens += usage.totalTokens;
    });
  }

  return Object.values(usageMetrics);
}

// Function to get total completion tokens for a specific model
function getTotalCompletionTokensForModel(
  model: string,
  fromDate: string,
  toDate: string
): { promptTokens: number; completionTokens: number } {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  let promptTokens = 0;
  let completionTokens = 0;

  for (let d = from; d <= to; d.setDate(d.getDate() + 1)) {
    const filePath = getFilePath(d.toISOString().split("T")[0]);
    const dailyUsage = readDataFromFile(filePath);

    dailyUsage.forEach((usage) => {
      if (usage.model === model) {
        promptTokens += usage.promptTokens;
        completionTokens += usage.completionTokens;
      }
    });
  }

  return { promptTokens, completionTokens };
}

// Function to delete usage data older than a specified date
function deleteOldUsageData(beforeDate: string): void {
  const before = new Date(beforeDate);

  fs.readdirSync(STORAGE_DIR).forEach((file) => {
    const filePath = path.join(STORAGE_DIR, file);
    const fileDate = file.split(".json")[0];
    if (new Date(fileDate) < before) {
      fs.unlinkSync(filePath);
    }
  });
}

// Export the module
export {
  saveApiUsage,
  getTotalUsage,
  getTotalCompletionTokensForModel,
  deleteOldUsageData,
  ApiUsage,
  UsageMetrics,
};
