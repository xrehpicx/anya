import { getJson } from "serpapi";
import { z } from "zod";

export const GoogleSearchParams = z.object({
  query: z.string(),
  engine: z
    .enum([
      "google_news",
      "google_scholar",
      "google_images",
      "google_flights",
      "google_jobs",
      "google_videos",
      "google_local",
      "google_maps",
      "google_shopping",
    ])
    .describe("search engine"),
  type: z
    .enum([
      "news_results",
      "organic_results",
      "local_results",
      "knowledge_graph",
      "recipes_results",
      "shopping_results",
      "jobs_results",
      "inline_videos",
      "inline_images",
      "all",
    ])
    .describe("type of results that correspond the selected search engine"),
  n: z.number().optional().describe("number of results"),
});
export type GoogleSearchParams = z.infer<typeof GoogleSearchParams>;
export async function search({ query, type, n, engine }: GoogleSearchParams) {
  if (!process.env.SEARCH_API_KEY)
    return { response: "missing SEARCH_API_KEY env var" };

  const res = await getJson({
    engine: engine ?? "google",
    q: query,
    api_key: process.env.SEARCH_API_KEY,
    num: n,
  });

  if (type === "all") {
    return res;
  }

  if (res[type]) {
    return res[type];
  }
  return {
    response: `no results, for the specified type ${type}, try a different type maybe`,
  };
}
