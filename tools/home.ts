import { z } from "zod";
import axios, { AxiosError } from "axios";
import { zodFunction } from ".";
import {
  RunnableToolFunction,
  RunnableToolFunctionWithParse,
} from "openai/lib/RunnableFunction.mjs";
import Fuse from "fuse.js";
import { ask } from "./ask";
import { Message } from "../interfaces/message";
import { memory_manager_guide, memory_manager_init } from "./memory-manager";

// Global axios config for Home Assistant API
const homeAssistantUrl = "https://home.raj.how";
const token = process.env.HA_KEY;

const apiClient = axios.create({
  baseURL: `${homeAssistantUrl}/api`,
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
});

// -------------------- Caching Utility -------------------- //

type CacheEntry<T> = {
  data: T;
  timestamp: number;
};

class AsyncCache<T> {
  private cache: CacheEntry<T> | null = null;
  private fetchFunction: () => Promise<T>;
  private refreshing: boolean = false;
  private refreshInterval: number; // in milliseconds

  constructor(
    fetchFunction: () => Promise<T>,
    refreshInterval: number = 5 * 60 * 1000
  ) {
    // Default refresh interval: 5 minutes
    this.fetchFunction = fetchFunction;
    this.refreshInterval = refreshInterval;
  }

  async get(): Promise<T> {
    if (this.cache) {
      // Return cached data immediately
      this.refreshInBackground();
      return this.cache.data;
    } else {
      // No cache available, fetch data and cache it
      const data = await this.fetchFunction();
      this.cache = { data, timestamp: Date.now() };
      return data;
    }
  }

  private async refreshInBackground() {
    if (this.refreshing) return; // Prevent multiple simultaneous refreshes
    this.refreshing = true;

    // Perform the refresh without blocking the main thread
    this.fetchFunction()
      .then((data) => {
        this.cache = { data, timestamp: Date.now() };
      })
      .catch((error) => {
        console.error("Error refreshing cache:", error);
        // Optionally, handle the error (e.g., keep the old cache)
      })
      .finally(() => {
        this.refreshing = false;
      });
  }
}

// -------------------- Memoized Functions -------------------- //

// 1. Fetch all available services with caching
export async function getAllServicesRaw() {
  try {
    const response = await apiClient.get("/services");
    return response.data;
  } catch (error) {
    console.error("Error fetching services:", error);
    throw error;
  }
}

const servicesCache = new AsyncCache<any[]>(getAllServicesRaw);

export async function getAllServices() {
  try {
    const services = await servicesCache.get();
    return services;
  } catch (error) {
    return { error };
  }
}

// 2. Fetch all devices and their valid states and services with caching
export async function getAllDevicesRaw() {
  try {
    const response = await apiClient.get("/states");
    const services = await getAllServicesRaw();

    const devices = response.data.map((device: any) => {
      const domain = device.entity_id.split(".")[0];

      // Find valid services for this entity's domain
      const domainServices =
        services.find((service: any) => service.domain === domain)?.services ||
        [];

      return {
        entity_id: device.entity_id,
        state: device.state,
        friendly_name: device.attributes.friendly_name || "",
        valid_services: domainServices, // Add the valid services for this device
        attributes: {
          valid_states: device.attributes.valid_states || [],
        },
      };
    });

    return devices;
  } catch (error) {
    console.error("Error fetching devices:", error);
    throw error;
  }
}

const devicesCache = new AsyncCache<any[]>(getAllDevicesRaw);

export async function getAllDevices() {
  try {
    const devices = await devicesCache.get();
    return { devices };
  } catch (error) {
    return { error };
  }
}

// -------------------- Existing Functionality -------------------- //

// Schema for setting the state with service and optional parameters
export const SetDeviceStateParams = z.object({
  entity_id: z.string(),
  service: z.string(), // Taking service directly
  value: z
    .string()
    .optional()
    .describe(
      "The value to set for the service. use this for simple use cases like for setting text, for more complex use cases use params"
    ),
  params: z
    .object({})
    .optional()
    .describe(
      `This object contains optional parameters for the service. For example, you can pass the brightness, color, or other parameters specific to the service.`
    ), // Optional parameters for the service (e.g., brightness, color)
});
export type SetDeviceStateParams = z.infer<typeof SetDeviceStateParams>;

// Schema for fuzzy search
export const FuzzySearchParams = z.object({
  query: z.string(),
});
export type FuzzySearchParams = z.infer<typeof FuzzySearchParams>;

// 3. Fuzzy search devices and include valid services
export async function fuzzySearchDevices({ query }: FuzzySearchParams) {
  try {
    // Fetch all devices with their services
    const { devices }: any = await getAllDevices();

    if (!devices) {
      return { error: "No devices data available." };
    }

    const fuseOptions = {
      keys: ["friendly_name", "entity_id"],
      threshold: 0.3, // Controls the fuzziness, lower value means stricter match
    };

    const fuse = new Fuse(devices, fuseOptions);
    const results = fuse.search(query);

    // Get top 2 results
    const topMatches = results.slice(0, 2).map((result) => result.item);

    return { matches: topMatches };
  } catch (error) {
    console.error("Error performing fuzzy search:", error);
    return { error };
  }
}

// 4. Function to set the state of a device via a service

// Updated setDeviceState function
export async function setDeviceState({
  entity_id,
  service,
  value,
  params = {},
}: SetDeviceStateParams) {
  try {
    const domain = entity_id.split(".")[0];

    // Fetch valid services for the specific domain
    const valid_services = await getServicesForDomain(domain);

    // Ensure valid_services is an object and extract the service keys
    const valid_service_keys = valid_services
      ? Object.keys(valid_services)
      : [];

    // Check if the passed service is valid
    if (!valid_service_keys.includes(service)) {
      return {
        success: false,
        message: `Invalid service '${service}' for entity ${entity_id}. Valid services are: ${valid_service_keys.join(
          ", "
        )}.`,
      };
    }

    if (!params && !value) {
      return {
        success: false,
        message: `No value or params provided for service '${service}' for entity ${entity_id}.`,
      };
    }

    // Send a POST request to the appropriate service endpoint with optional parameters
    const response = await apiClient.post(`/services/${domain}/${service}`, {
      entity_id,
      value,
      ...params,
    });

    return { success: response.status === 200 };
  } catch (error) {
    const err = error as AxiosError;
    const errMessage = err.response?.data || { message: err.message };
    console.error(
      `Error setting state for device ${entity_id}:`,
      JSON.stringify(errMessage, null, 2)
    );
    return { errMessage };
  }
}

// Schema for getting device state
export const GetDeviceStateParams = z.object({
  entity_id: z.string(),
});
export type GetDeviceStateParams = z.infer<typeof GetDeviceStateParams>;

// Fetch services for a specific domain (e.g., light, switch)
async function getServicesForDomain(domain: string) {
  try {
    const services = await getAllServices();
    if ("error" in services) throw services.error;

    const domainServices = services.find(
      (service: any) => service.domain === domain
    );
    return domainServices ? domainServices.services : [];
  } catch (error) {
    console.error(`Error fetching services for domain ${domain}:`, error);
    return [];
  }
}

// Function to get the current state and valid services of a specific device
export async function getDeviceState({ entity_id }: GetDeviceStateParams) {
  try {
    // Fetch the device state
    const response = await apiClient.get(`/states/${entity_id}`);
    const device = response.data;

    // Extract the domain from entity_id (e.g., "light", "switch")
    const domain = entity_id.split(".")[0];

    // Fetch services for the specific domain
    const valid_services = await getServicesForDomain(domain);

    // Return device state and valid services
    return {
      entity_id: device.entity_id,
      state: device.state,
      friendly_name: device.attributes.friendly_name || "",
      valid_services, // Return valid services for this device
      attributes: {
        valid_states: device.attributes.valid_states || [],
      },
    };
  } catch (error) {
    console.error(`Error fetching state for device ${entity_id}:`, error);
    return {
      error,
    };
  }
}

// Tools export
export let homeAssistantTools: RunnableToolFunctionWithParse<any>[] = [
  // zodFunction({
  //   function: getAllDevices,
  //   name: "homeAssistantGetAllDevices",
  //   schema: z.object({}), // No parameters needed
  //   description:
  //     "Get a list of all devices with their current states and valid services that can be called.",
  // }),
  zodFunction({
    function: setDeviceState,
    name: "homeAssistantSetDeviceState",
    schema: SetDeviceStateParams,
    description: `Set the state of a specific device by calling a valid service, such as 'turn_on' or 'turn_off'.
    
    For simple text fields u can just use the following format too:

    `,
  }),
  zodFunction({
    function: fuzzySearchDevices,
    name: "homeAssistantFuzzySearchDevices",
    schema: FuzzySearchParams,
    description:
      "Search devices by name and return their entity_id, current state, and valid services that can be called to control the device.",
  }),
];

export const HomeManagerParams = z.object({
  request: z.string().describe("What the user wants to do with which device"),
  // device_name: z.string().describe("What the user referred to the device as"),
  devices: z
    .array(z.string())
    .describe("The vague device names to potentially take action on"),
});
export type HomeManagerParams = z.infer<typeof HomeManagerParams>;

export async function homeManager(
  { request, devices }: HomeManagerParams,
  context_message: Message
) {
  const allMatches = [];

  for (const device of devices) {
    const { matches } = await fuzzySearchDevices({ query: device });
    if (matches?.length) {
      allMatches.push(...matches);
    }
  }

  if (allMatches.length === 0) {
    return {
      error: `No devices found matching the provided names. Please try again.`,
    };
  }

  const response = await ask({
    model: "gpt-4o-mini",
    prompt: `You are a home assistant manager.
    
----
${memory_manager_guide("homeassistant-manager", context_message.author.id)}
----

    Similar devices were found based on the names provided:
    ${JSON.stringify(allMatches)}

    These are the devices that they may actually be referring to:
    ${JSON.stringify(allMatches)}
    
    Read the request carefully and perform the necessary action on only the RELEVANT devices.
    `,
    message: request,
    seed: `home-${context_message.channelId}`,
    tools: [
      ...homeAssistantTools,
      memory_manager_init(context_message, "homeassistant-manager"),
    ],
  });

  return {
    response: response.choices[0].message.content,
  };
}
