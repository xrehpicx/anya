import OpenAI from "openai";
import { z } from "zod";

// get meta data from url
export const ServiceCheckerParams = z.object({
  query: z.string(),
});

export type ServiceCheckerParams = z.infer<typeof ServiceCheckerParams>;

const ai_token = process.env.OPENAI_API_KEY?.trim();
const openai = new OpenAI({
  apiKey: ai_token,
});

export async function service_checker({ query }: ServiceCheckerParams) {
  const status_pages = [
    "http://192.168.29.85:3001/status/tokio",
    "https://ark-status.raj.how/status/ark",
  ];

  // fetch the html of the status pages
  const status_page_html_promises = await Promise.allSettled(
    status_pages.map(async (url) => {
      const res = await fetch(url);
      return res.text();
    })
  );

  const status_page_html = status_page_html_promises.map((res) => {
    if (res.status === "fulfilled") {
      return res.value;
    }
    return res.reason;
  });

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are a service status bot that takes in a user query about a service and responds with the status of the service.

        The HTML of the status pages is: "${status_page_html}".

        The user query is: "${query}".        
              `,
      },
      {
        role: "user",
        content: query,
      },
    ],
  });

  return {
    response: res.choices[0].message.content,
  };
}
