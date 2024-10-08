import axios from "axios";
import { z } from "zod";
import { zodFunction } from ".";
import { RunnableToolFunction } from "openai/lib/RunnableFunction.mjs";
import { ask } from "./ask";
import { Message } from "../interfaces/message";
import { memory_manager_guide, memory_manager_init } from "./memory-manager";

const apiClient = axios.create({
  baseURL: "https://link.raj.how/api/v1",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.LINKWARDEN_API_KEY}`,
  },
});

// Schemas for each function's parameters
export const ArchivedFileParams = z.object({
  id: z.string(),
  format: z.string().optional(),
});
export type ArchivedFileParams = z.infer<typeof ArchivedFileParams>;

export const TagParams = z.object({
  id: z.string(),
});
export type TagParams = z.infer<typeof TagParams>;

export const TagUpdateParams = z.object({
  id: z.string(),
  name: z.string().optional(),
  color: z.string().optional(),
});
export type TagUpdateParams = z.infer<typeof TagUpdateParams>;

export const CollectionParams = z.object({
  id: z.string(),
});
export type CollectionParams = z.infer<typeof CollectionParams>;

export const CollectionLinksParams = z.object({
  collectionId: z.string(),
  tag: z.string().optional(),
  sortBy: z.string().optional(),
  limit: z.number().optional(),
});
export type CollectionLinksParams = z.infer<typeof CollectionLinksParams>;

export const ProfileParams = z.object({
  id: z.string(),
});
export type ProfileParams = z.infer<typeof ProfileParams>;

export const MigrationParams = z.object({
  data: z.string(),
});
export type MigrationParams = z.infer<typeof MigrationParams>;

export const LinksParams = z.object({
  collectionId: z.string().optional(),
  tag: z.string().optional(),
  sortBy: z.string().optional(),
  limit: z.number().optional(),
});
export type LinksParams = z.infer<typeof LinksParams>;

export const LinkParams = z.object({
  id: z.string(),
});
export type LinkParams = z.infer<typeof LinkParams>;

export const LinkUpdateParams = z.object({
  id: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  description: z.string().optional(),
  tagIds: z.array(z.string()).optional(),
});
export type LinkUpdateParams = z.infer<typeof LinkUpdateParams>;

export const ProfilePhotoParams = z.object({
  id: z.string(),
});
export type ProfilePhotoParams = z.infer<typeof ProfilePhotoParams>;

// Functions
export async function getArchivedFile({ id, format }: ArchivedFileParams) {
  try {
    const response = await apiClient.get(`/archives/${id}`, {
      params: { format },
    });
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function getAllTags() {
  try {
    const response = await apiClient.get("/tags");
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function updateTag({ id, name, color }: TagUpdateParams) {
  try {
    const response = await apiClient.put(`/tags/${id}`, { name, color });
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function deleteTag({ id }: TagParams) {
  try {
    const response = await apiClient.delete(`/tags/${id}`);
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function getPublicCollectionInfo({ id }: CollectionParams) {
  try {
    const response = await apiClient.get(`/public/collections/${id}`);
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function getLinksUnderPublicCollection({
  collectionId,
  tag,
  sortBy,
  limit,
}: CollectionLinksParams) {
  try {
    const response = await apiClient.get("/public/collections/links", {
      params: { collectionId, tag, sortBy, limit },
    });
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function getSingleLinkUnderPublicCollection({ id }: LinkParams) {
  try {
    const response = await apiClient.get(`/public/links/${id}`);
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function getPublicProfileInfo({ id }: ProfileParams) {
  try {
    const response = await apiClient.get(`/public/users/${id}`);
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function importData({ data }: MigrationParams) {
  try {
    const response = await apiClient.post("/migration", { data });
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function exportData({ data }: MigrationParams) {
  try {
    const response = await apiClient.get("/migration", { params: { data } });
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function getLinks({
  collectionId,
  tag,
  sortBy,
  limit,
}: LinksParams) {
  try {
    const response = await apiClient.get("/links", {
      params: { collectionId, tag, sortBy, limit },
    });
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function getLink({ id }: LinkParams) {
  try {
    const response = await apiClient.get(`/links/${id}`);
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

// Schema for adding a link
export const AddLinkParams = z.object({
  url: z.string(),
  name: z.string(),
  type: z.string(),
  tags: z.array(
    z.object({
      name: z.string(),
    })
  ),
  collection: z.object({
    id: z.number().default(8).optional(),
  }),
});
export type AddLinkParams = z.infer<typeof AddLinkParams>;

// Function to add a link
export async function addLink(params: AddLinkParams) {
  try {
    const response = await apiClient.post("/links", params);
    return response.data;
  } catch (error) {
    console.error(error);
    return `Error: ${error}`;
  }
}

export async function updateLink({
  id,
  title,
  url,
  description,
  tagIds,
}: LinkUpdateParams) {
  try {
    const response = await apiClient.put(`/links/${id}`, {
      title,
      url,
      description,
      tagIds,
    });
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function deleteLink({ id }: LinkParams) {
  try {
    const response = await apiClient.delete(`/links/${id}`);
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function triggerArchiveForLink({ id }: LinkParams) {
  try {
    const response = await apiClient.put(`/links/${id}/archive`);
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function getDashboardData() {
  try {
    const response = await apiClient.get("/dashboard");
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function getCollections() {
  try {
    const response = await apiClient.get("/collections");
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export async function getProfilePhoto({ id }: ProfilePhotoParams) {
  try {
    const response = await apiClient.get(`/avatar/${id}`);
    return response.data;
  } catch (error) {
    return `Error: ${error}`;
  }
}

export let link_tools: RunnableToolFunction<any>[] = [
  zodFunction({
    function: getAllTags,
    name: "linkwardenGetAllTags",
    schema: z.object({}),
    description: "Get all tags for the user.",
  }),
  zodFunction({
    function: updateTag,
    name: "linkwardenUpdateTag",
    schema: TagUpdateParams,
    description: "Update a tag.",
  }),
  zodFunction({
    function: deleteTag,
    name: "linkwardenDeleteTag",
    schema: TagParams,
    description: "Delete a tag.",
  }),
  zodFunction({
    function: getPublicCollectionInfo,
    name: "linkwardenGetPublicCollectionInfo",
    schema: CollectionParams,
    description: "Get public collection info.",
  }),
  zodFunction({
    function: getLinksUnderPublicCollection,
    name: "linkwardenGetLinksUnderPublicCollection",
    schema: CollectionLinksParams,
    description: "Get links under a public collection.",
  }),
  zodFunction({
    function: getSingleLinkUnderPublicCollection,
    name: "linkwardenGetSingleLinkUnderPublicCollection",
    schema: LinkParams,
    description: "Get a single link under a public collection.",
  }),
  zodFunction({
    function: getPublicProfileInfo,
    name: "linkwardenGetPublicProfileInfo",
    schema: ProfileParams,
    description: "Get public profile info.",
  }),
  zodFunction({
    function: getLinks,
    name: "linkwardenGetLinks",
    schema: LinksParams,
    description: "Get links under a collection.",
  }),
  zodFunction({
    function: getLink,
    name: "linkwardenGetLink",
    schema: LinkParams,
    description: "Get a single link under a collection.",
  }),
  zodFunction({
    function: updateLink,
    name: "linkwardenUpdateLink",
    schema: LinkUpdateParams,
    description: "Update a link.",
  }),
  zodFunction({
    function: addLink,
    name: "linkwardenAddLink",
    schema: AddLinkParams,
    description:
      "Add a link (default to 'Anya' collection with id=8 if not specified).",
  }),
  zodFunction({
    function: deleteLink,
    name: "linkwardenDeleteLink",
    schema: LinkParams,
    description: "Delete a link.",
  }),
  zodFunction({
    function: triggerArchiveForLink,
    name: "linkwardenTriggerArchiveForLink",
    schema: LinkParams,
    description: "Trigger archive for a link.",
  }),
  zodFunction({
    function: getDashboardData,
    name: "linkwardenGetDashboardData",
    schema: z.object({}),
    description: "Get dashboard data.",
  }),
  zodFunction({
    function: getCollections,
    name: "linkwardenGetCollections",
    schema: z.object({}),
    description: "Get all collections for the user.",
  }),
];

export const LinkManagerParams = z.object({
  request: z
    .string()
    .describe("User's request regarding links, tags, or collections."),
});
export type LinkManagerParams = z.infer<typeof LinkManagerParams>;

export async function linkManager(
  { request }: LinkManagerParams,
  context_message: Message
) {
  const response = await ask({
    model: "gpt-4o-mini",
    prompt: `You are a Linkwarden manager.

Your job is to understand the user's request and manage links, tags, or collections using the available tools.

----
${memory_manager_guide("links_manager", context_message.author.id)}
----
    `,
    message: request,
    seed: "link-${context_message.channelId}",
    tools: link_tools.concat(
      memory_manager_init(context_message, "links_manager")
    ) as any,
  });

  return { response };
}
