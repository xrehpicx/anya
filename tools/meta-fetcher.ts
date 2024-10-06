import metaFetcher from "meta-fetcher";
import { z } from "zod";

// get meta data from url
export const MetaFetcherParams = z.object({
  url: z.string(),
});
export type MetaFetcherParams = z.infer<typeof MetaFetcherParams>;
export async function meta_fetcher({ url }: MetaFetcherParams) {
  return await metaFetcher(url);
}
