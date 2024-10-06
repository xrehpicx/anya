import { Elysia, t } from "elysia";
import { userConfigs } from "../config";
import { send_sys_log } from "./log";

// Define the type for the event callback
type EventCallback = (
  payload: Record<string, string | number>
) => void | Record<string, any> | Promise<void> | Promise<Record<string, any>>;

/**
 * EventManager handles registration and emission of events based on event IDs.
 */
class EventManager {
  private listeners: Map<string, Set<EventCallback>> = new Map();

  /**
   * Registers a new listener for a specific event ID.
   * @param id - The event ID to listen for.
   * @param callback - The callback to invoke when the event is emitted.
   */
  on(id: string, callback: EventCallback): void {
    if (!this.listeners.has(id)) {
      this.listeners.set(id, new Set());
    }
    this.listeners.get(id)!.add(callback);
  }

  /**
   * Removes a specific listener for a given event ID.
   * @param id - The event ID.
   * @param callback - The callback to remove.
   */
  off(id: string, callback: EventCallback): void {
    if (this.listeners.has(id)) {
      this.listeners.get(id)?.delete(callback);
    }
  }

  /**
   * Emits an event, triggering all registered listeners for the given event ID.
   * This method does not wait for listeners to complete and does not collect their responses.
   * @param id - The event ID to emit.
   * @param payload - The payload to pass to the listeners.
   */
  emit(id: string, payload: Record<string, string | number>): void {
    const callbacks = this.listeners.get(id);
    if (callbacks) {
      callbacks.forEach((cb) => {
        try {
          cb(payload);
        } catch (error) {
          console.error(`Error in listener for event '${id}':`, error);
        }
      });
    }
  }

  /**
   * Emits an event and waits for all listeners to complete.
   * Collects and returns the responses from the listeners.
   * @param id - The event ID to emit.
   * @param payload - The payload to pass to the listeners.
   * @returns An array of responses from the listeners.
   */
  async emitWithResponse(
    id: string,
    payload: Record<string, string | number>
  ): Promise<any[]> {
    const callbacks = this.listeners.get(id);
    const responses: any[] = [];

    if (callbacks) {
      // Execute all callbacks and collect their responses
      const promises = Array.from(callbacks).map(async (cb) => {
        try {
          const result = cb(payload);
          if (result instanceof Promise) {
            return await result;
          }
          return result;
        } catch (error) {
          console.error(`Error in listener for event '${id}':`, error);
          return null;
        }
      });

      const results = await Promise.all(promises);
      // Filter out undefined or null responses
      results.forEach((res) => {
        if (res !== undefined && res !== null) {
          responses.push(res);
        }
      });
    }

    return responses;
  }
}

// Instantiate the EventManager
const eventManager = new EventManager();

// Create the Elysia server
export const events = new Elysia()
  .get("/", () => "Anya\nExternal event listener running")
  .get(
    "/events/:id",
    async ({ params: { id }, query, headers }) => {
      const wait = query.wait;
      delete query.wait;

      if (id === "ping") {
        console.log("Event received", query);
        send_sys_log(`Ping event received: ${JSON.stringify(query)}`);

        if (wait) {
          const responses = await eventManager.emitWithResponse(
            "ping",
            query as Record<string, string | number>
          );
          return { response: "pong", listeners: responses };
        } else {
          eventManager.emit("ping", query as Record<string, string | number>);
          return "pong";
        }
      }

      console.log("get hook", id);
      console.log("Event received", query);

      if (!headers.token) {
        return { error: "Unauthorized" };
      }

      const [username, password] = headers.token.split(":");
      const user = userConfigs.find((config) => config.name === username);

      if (!user) {
        return { error: "Unauthorized" };
      }

      const found = user.identities.find(
        (identity) => identity.platform === "events" && identity.id === password
      );

      // console.log("found", found);
      if (!found) {
        return { error: "Unauthorized" };
      }

      send_sys_log(`Event (${id}) received: ${JSON.stringify(query)}`);

      if (wait) {
        const responses = await eventManager.emitWithResponse(
          id,
          query as Record<string, string | number>
        );
        return { response: "Event received", listeners: responses };
      } else {
        eventManager.emit(id, query as Record<string, string | number>);
        return "Event received";
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      query: t.Object({
        wait: t.Optional(t.Boolean()),
      }),
    }
  )
  .post(
    "/events/:id",
    async ({ params: { id }, body, headers, query }) => {
      const wait = query.wait;

      console.log("post hook", id);

      // console.log("Event received", body);
      // Handle ArrayBuffer body
      if (body instanceof ArrayBuffer) {
        const textbody = new TextDecoder().decode(body as ArrayBuffer);
        try {
          body = JSON.parse(textbody);
        } catch (e) {
          body = textbody;
        }
      }
      // console.log("Event received", body);

      if (id === "ping") {
        send_sys_log(`Ping event received: ${JSON.stringify(body)}`);
        if (wait) {
          const responses = await eventManager.emitWithResponse(
            "ping",
            body as Record<string, string | number>
          );
          return { response: "pong", listeners: responses };
        } else {
          eventManager.emit("ping", body as Record<string, string | number>);
          return "pong";
        }
      }

      if (!headers.token) {
        return { error: "Unauthorized" };
      }

      const [username, password] = headers.token.split(":");
      const user = userConfigs.find((config) => config.name === username);

      if (!user) {
        return { error: "Unauthorized" };
      }

      const found = user.identities.find(
        (identity) => identity.platform === "events" && identity.id === password
      );

      if (!found) {
        return { error: "Unauthorized" };
      }

      send_sys_log(`Event (${id}) received: ${JSON.stringify(body)}`);

      if (wait) {
        const responses = await eventManager.emitWithResponse(
          id,
          body as Record<string, string | number>
        );
        return { responses: responses };
      } else {
        eventManager.emit(id, body as Record<string, string | number>);
        return "Event received";
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Any(),
      query: t.Object({
        wait: t.Optional(t.Boolean()),
      }),
    }
  );

// Function to start the server
export function startEventsServer() {
  const port = parseInt(process.env.EVENTS_PORT || "7004", 10);
  events.listen(port, () => {
    console.log(`Events Server is running on port ${port}`);
  });
}

// Export the eventManager to allow other modules to register listeners
export { eventManager };
