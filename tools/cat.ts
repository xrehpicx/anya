import { z } from "zod";

export const GenerateCatImageUrlParams = z.object({
  tag: z.string().optional(),
  text: z.string().optional(),
  fontSize: z.number().optional(),
  fontColor: z.string().optional(),
  gif: z.boolean().optional(),
});
export type GenerateCatImageUrlParams = z.infer<
  typeof GenerateCatImageUrlParams
>;

export const GenerateCatImageUrlResponse = z.string();
export type GenerateCatImageUrlResponse = z.infer<
  typeof GenerateCatImageUrlResponse
>;

export async function generate_cat_image_url({
  tag,
  text,
  fontSize,
  fontColor,
  gif,
}: GenerateCatImageUrlParams): Promise<object> {
  let url = "/cat";

  if (gif) {
    url += "/gif";
  }

  if (tag) {
    url += `/${tag}`;
  }

  if (text) {
    url += `/says/${text}`;
  }

  if (fontSize || fontColor) {
    if (!text) {
      url += `/says/`; // Ensuring 'says' is in the URL for font options
    }
    url += `${text ? "" : "?"}`;
    if (fontSize) {
      url += `fontSize=${fontSize}`;
    }
    if (fontColor) {
      url += `${fontSize ? "&" : ""}fontColor=${fontColor}`;
    }
  }

  return { url };
}
