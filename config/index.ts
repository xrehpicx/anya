import fs from "fs";
import { z } from "zod";
import path from "path";

export const dataDir = path.join(process.env.ANYA_DIR || "./");
export const pathInDataDir = (filename: string) => path.join(dataDir, filename);

interface PlatformIdentity {
  platform: "discord" | "whatsapp" | "email" | "events";
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
  platform: z.enum(["discord", "whatsapp", "email", "events"]),
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

// Load user configuration data from file
const userConfigPath = pathInDataDir("user-config.json");
const rawData = fs.readFileSync(userConfigPath, "utf-8");
const parsedData = JSON.parse(rawData);

// Validate the parsed JSON using the Zod schema
const configData = ConfigSchema.parse(parsedData);

// Export the validated data
export const { users: userConfigs, rolePermissions } = configData;
