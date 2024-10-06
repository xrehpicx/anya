import puppeteer from "puppeteer";
import TurndownService from "turndown";
import { z } from "zod";
import { ask } from "./ask";

interface ScrapedData {
  meta: {
    title: string;
    description: string;
    coverImage: string;
    [key: string]: string;
  };
  body: string;
}

async function scrapeAndConvertToMarkdown(url: string): Promise<ScrapedData> {
  try {
    // Launch Puppeteer browser
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    // Navigate to the URL
    await page.goto(url, { waitUntil: "networkidle2" });

    // Extract metadata and body content using Puppeteer
    const result = await page.evaluate(() => {
      const meta: any = {
        title: document.querySelector("head > title")?.textContent || "",
        description:
          document
            .querySelector('meta[name="description"]')
            ?.getAttribute("content") || "",
        coverImage:
          document
            .querySelector('meta[property="og:image"]')
            ?.getAttribute("content") || "",
      };

      const body = document.querySelector("body")?.innerHTML || "";

      return { meta, body };
    });

    // Close Puppeteer browser
    await browser.close();

    // Initialize Turndown service
    const turndownService = new TurndownService();

    // Convert HTML to Markdown
    const markdown = turndownService.turndown(result.body);

    // Structure the return object
    const scrapedData: ScrapedData = {
      meta: result.meta,
      body: markdown,
    };

    return scrapedData;
  } catch (error) {
    console.error("Error fetching or converting content:", error);
    throw new Error("Failed to scrape and convert content");
  }
}

// Define the parameters schema using Zod
export const ScrapeAndConvertToMarkdownParams = z.object({
  url: z.string().describe("The URL of the webpage to scrape"),
  summary: z
    .boolean()
    .default(true)
    .optional()
    .describe("Whether to return a summary or the entire content"),
  summary_instructions: z.string().optional()
    .describe(`Instructions for summarizing the content.
    Example: "Return only the author list and their affiliations not the full website content."
    This can be used to:
    1. Filter out information that is not needed.
    2. Scope the summary to a specific part of the content.
    3. Provide context for the summary.
    4. Extracting specific information from the content / formatting.
`),
});

export type ScrapeAndConvertToMarkdownParams = z.infer<
  typeof ScrapeAndConvertToMarkdownParams
>;

export async function scrape_and_convert_to_markdown({
  url,
  summary,
}: ScrapeAndConvertToMarkdownParams) {
  try {
    const result = await scrapeAndConvertToMarkdown(url);
    if (summary) {
      const summaryResult = await ask({
        prompt: `Summarize the following content: \n\n${result.body}`,
        model: "groq-small",
      });
      return {
        meta: result.meta,
        summary: summaryResult.choices[0].message.content,
      };
    }
    return result;
  } catch (error) {
    return { error };
  }
}
