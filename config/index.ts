import fs from "fs";
import { z } from "zod";
import path from "path";

export const dataDir = path.join(process.env.ANYA_DIR || "./");
export const pathInDataDir = (filename: string) => path.join(dataDir, filename);

interface PlatformIdentity {
  platform:
  | "discord"
  | "whatsapp"
  | "email"
  | "events"
  | "linear_key"
  | "linear_email";
  id: string; // Platform-specific user ID
}

export interface UserConfig {
  name: string;
  identities: PlatformIdentity[];
  friends?: {
    related_as: string[];
    user: UserConfig;
  }[];
  roles: string[]; // Roles assigned to the user
}

// Define Zod schemas for validation
const PlatformIdentitySchema = z.object({
  platform: z.enum([
    "discord",
    "whatsapp",
    "email",
    "events",
    "linear_key",
    "linear_email",
  ]),
  id: z.string(),
});

const UserConfigSchema: z.ZodType<UserConfig> = z.lazy(() =>
  z.object({
    name: z.string(),
    identities: z.array(PlatformIdentitySchema),
    friends: z
      .array(
        z.object({
          related_as: z.array(z.string()),
          user: UserConfigSchema, // recursive schema for relatives
        })
      )
      .optional(),
    roles: z.array(z.string()),
  })
);

// Schema for the full configuration file
const ConfigSchema = z.object({
  users: z.array(UserConfigSchema),
  rolePermissions: z.record(z.string(), z.array(z.string())),
});

// Mutable exports that will be updated
export let userConfigs: UserConfig[] = [];
export let rolePermissions: Record<string, string[]> = {};

// Function to load config
function loadConfig() {
  try {
    const userConfigPath = pathInDataDir("user-config.json");
    const rawData = fs.readFileSync(userConfigPath, "utf-8");
    const parsedData = JSON.parse(rawData);
    const configData = ConfigSchema.parse(parsedData);

    // Update the exported variables
    userConfigs = configData.users;
    rolePermissions = configData.rolePermissions;
  } catch (error) {
    console.error("Error loading config:", error);
  }
}

// Initial load
loadConfig();

// Setup auto-reload every minute
setInterval(loadConfig, 60 * 1000);
