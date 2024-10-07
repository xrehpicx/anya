import { z } from "zod";
import { userConfigs } from "../config";
import { ask } from "./ask";
import { Message } from "../interfaces/message";

export const SearchUserParams = z.object({
  name: z.string().describe("The name of the user to search for."),
  platform: z
    .string()
    .optional()
    .describe(
      "The platform to search for the user, this will default to discord."
    ),
});

export type SearchUserParams = z.infer<typeof SearchUserParams>;

export async function search_user(
  { name, platform }: SearchUserParams,
  context_message: Message
) {
  try {
    console.log(JSON.stringify(userConfigs));
    const res = await ask({
      prompt: `You are a Search Tool that takes in a name and platform and returns the user's details. You are searching for ${name} on ${platform}.
      
      You need to search for the user in the user config 1st.
      ${JSON.stringify(userConfigs)}

      Return found user in a simple format.
      `,
    });
    console.log(res.choices[0].message);
    return {
      response: res.choices[0].message,
    };
  } catch (error) {
    return {
      error,
    };
  }
}
