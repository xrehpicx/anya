import OpenAI from "openai";
import { TranscriptResponse, YoutubeTranscript } from "youtube-transcript";
import { z } from "zod";
import ytdl from "ytdl-core";
import crypto from "crypto";
import fs from "fs";
import { encoding_for_model } from "@dqbd/tiktoken";
import { ask } from "./ask";
import { pathInDataDir } from "../config";

export const YoutubeTranscriptParams = z.object({
  url: z.string(),
  mode: z
    .enum(["summary", "full"])
    .default("summary")
    .describe(
      "summary or full transcript if user needs something specific out of the video, use full only when the user explicitly asks for it."
    ),
  query: z
    .string()
    .optional()
    .describe(
      "anything specific to look for in the video, use this for general search queries like 'when was x said in this video' or 'what was the best part of this video'"
    ),
});
export type YoutubeTranscriptParams = z.infer<typeof YoutubeTranscriptParams>;

export async function get_youtube_video_data({
  url,
  query,
  mode,
}: YoutubeTranscriptParams) {
  let youtube_meta_data:
    | {
        title: string;
        description: string | null;
        duration: string;
        author: string;
        views: string;
        publishDate: string;
        thumbnailUrl: string;
      }
    | string;
  let transcripts: TranscriptResponse[] | string = "";

  try {
    youtube_meta_data = await getYouTubeVideoMetadata(url);
  } catch (error) {
    console.error(error);
    youtube_meta_data = JSON.stringify(error);
  }

  try {
    transcripts = await YoutubeTranscript.fetchTranscript(url);
  } catch (error) {
    console.error(error);
    transcripts = JSON.stringify(error);
  }

  const summary =
    mode === "summary"
      ? await summerize_video(
          `youtube_meta_data:
  ${
    typeof youtube_meta_data === "string"
      ? "error fetching meta data, but transcripts maybe available."
      : JSON.stringify({
          title: youtube_meta_data.title,
          description: youtube_meta_data.description,
          duration: youtube_meta_data.duration,
          author: youtube_meta_data.author,
          publishing_date: youtube_meta_data.publishDate,
        })
  }
  
  transcripts:
  ${
    typeof transcripts === "string"
      ? "error fetching transcripts"
      : JSON.stringify(transcripts)
  }
  `,
          query
        )
      : undefined;

  return {
    youtube_meta_data,
    summary,
    transcripts: mode === "full" ? transcripts : undefined,
  };
}

const ai_token = process.env.OPENAI_API_KEY?.trim();

// save summaries by updating a summary.json file with a hash for the input text
function save_summary(text: string, summary: string) {
  const hash = crypto.createHash("sha256");
  hash.update(text);
  const hash_text = hash.digest("hex");

  const summariesPath = pathInDataDir("summary.json");
  let summaries: Record<string, string> = {};
  try {
    summaries = require(summariesPath);
  } catch (error) {
    console.error("Error loading summaries", error);
  }
  summaries[hash_text] = summary;
  fs.writeFileSync(summariesPath, JSON.stringify(summaries));
}

function get_summary(text: string) {
  const hash = crypto.createHash("sha256");
  hash.update(text);
  const hash_text = hash.digest("hex");

  const summariesPath = pathInDataDir("summary.json");
  let summaries = null;
  try {
    summaries = fs.readFileSync(summariesPath);
  } catch (error) {
    fs.writeFileSync(summariesPath, JSON.stringify({}));
  }

  if (!summaries) {
    return null;
  }

  try {
    return JSON.parse(summaries.toString())[hash_text];
  } catch (error) {
    console.error("Failed to parse summaries", error);
    return null;
  }
}

function numTokensFromString(message: string) {
  const encoder = encoding_for_model("gpt-3.5-turbo");

  const tokens = encoder.encode(message);
  encoder.free();
  return tokens.length;
}

async function summerize_video(text: string, query?: string) {
  const openai = new OpenAI({
    apiKey: ai_token,
  });

  const saved_summary = get_summary(text);

  if (saved_summary && query) {
    text = saved_summary;
  } else if (saved_summary) {
    return saved_summary;
  }

  const res = await ask({
    model: "groq-small",
    prompt: `Summarize all of the youtube info about the given youtube video.

    Youtube Data:
    -----
    ${text}
    -----
    Use the time stamps if available to point out the most important parts of the video or to highlight what the user was looking for in the video.
    Make sure to link these timed sections so the user can click on the link and directly go to that part of the video.
    Highlights should include things like something about the topic of the title or the description and not something about the author's self-promotion or the channel itself.
      `,
  });

  res.choices[0].message.content &&
    save_summary(text, res.choices[0].message.content);

  return res.choices[0].message.content;
}

async function getYouTubeVideoMetadata(url: string) {
  try {
    const info = await ytdl.getInfo(url);
    const videoDetails = info.videoDetails;

    const metadata = {
      title: videoDetails.title,
      description: videoDetails.description,
      duration: videoDetails.lengthSeconds, // in seconds
      author: videoDetails.author.name,
      views: videoDetails.viewCount,
      publishDate: videoDetails.publishDate,
      thumbnailUrl:
        videoDetails.thumbnails[videoDetails.thumbnails.length - 1]?.url,
    };

    return metadata;
  } catch (error) {
    console.error("Error fetching video metadata:", error);
    return "Error fetching video metadata";
  }
}

// youtube downloader tool
export const YoutubeDownloaderParams = z.object({
  url: z.string(),

  quality: z.enum([
    "highest",
    "lowest",
    "highestaudio",
    "lowestaudio",
    "highestvideo",
    "lowestvideo",
  ]),
});

export type YoutubeDownloaderParams = z.infer<typeof YoutubeDownloaderParams>;

export async function get_download_link({
  url,
  quality,
}: YoutubeDownloaderParams) {
  try {
    const info = await ytdl.getInfo(url);
    const link = ytdl.chooseFormat(info.formats, { quality: quality });

    return link.url;
  } catch (error) {
    console.error("Error fetching video metadata:", error);
    return "Error fetching video metadata";
  }
}
