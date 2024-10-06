// tool to search whatsapp contacts

import { z } from "zod";
import { whatsappAdapter } from "../interfaces";

export const SearchContactsParams = z.object({
  query: z.string().min(3).max(50),
});

export type SearchContactsParams = z.infer<typeof SearchContactsParams>;

// Function to search contacts
export async function search_whatsapp_contacts({
  query,
}: SearchContactsParams) {
  try {
    const res = await whatsappAdapter.searchUser(query);
    return {
      results: res,
    };
  } catch (error) {
    return {
      error,
    };
  }
}
