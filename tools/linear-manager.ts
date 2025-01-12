import { z } from "zod";
import { zodFunction } from ".";
import { LinearClient } from "@linear/sdk";
import { Message } from "../interfaces/message";
import { userConfigs } from "../config";
import { ask } from "./ask";
import { RunnableToolFunction } from "openai/lib/RunnableFunction.mjs";
import { memory_manager_guide, memory_manager_init } from "./memory-manager";

// Parameter Schemas
export const IssueParams = z.object({
  teamId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  assigneeId: z.string().optional(),
  projectId: z.string().optional(),
  priority: z.number().optional(),
  labelIds: z.array(z.string()).optional(),
});

export const UpdateIssueParams = z.object({
  issueId: z.string().describe("The ID of the issue to update"),
  // Basic fields
  title: z.string().optional().describe("The issue title"),
  description: z.string().optional().describe("The issue description in markdown format"),
  descriptionData: z.any().optional().describe("The issue description as a Prosemirror document"),
  priority: z.number().min(0).max(4).optional()
    .describe("The priority of the issue. 0 = No priority, 1 = Urgent, 2 = High, 3 = Normal, 4 = Low"),

  // Assignee and subscribers
  assigneeId: z.string().optional().describe("The identifier of the user to assign the issue to"),
  subscriberIds: z.array(z.string()).optional().describe("The identifiers of the users subscribing to this ticket"),

  // Labels
  labelIds: z.array(z.string()).optional()
    .describe("The complete set of label IDs to set on the issue (replaces existing labels)"),
  addedLabelIds: z.array(z.string()).optional()
    .describe("The identifiers of the issue labels to be added to this issue"),
  removedLabelIds: z.array(z.string()).optional()
    .describe("The identifiers of the issue labels to be removed from this issue"),

  // Status and workflow
  stateId: z.string().optional().describe("The team state of the issue"),
  estimate: z.number().optional().describe("The estimated complexity of the issue"),

  // Dates and scheduling
  dueDate: z.string().optional().describe("The date at which the issue is due (YYYY-MM-DD format)"),
  snoozedById: z.string().optional().describe("The identifier of the user who snoozed the issue"),
  snoozedUntilAt: z.string().optional().describe("The time until an issue will be snoozed in Triage view"),

  // Relationships
  parentId: z.string().optional().describe("The identifier of the parent issue"),
  projectId: z.string().optional().describe("The project associated with the issue"),
  projectMilestoneId: z.string().optional().describe("The project milestone associated with the issue"),
  teamId: z.string().optional().describe("The identifier of the team associated with the issue"),
  cycleId: z.string().optional().describe("The cycle associated with the issue"),

  // Sorting and positioning
  sortOrder: z.number().optional().describe("The position of the issue related to other issues"),
  boardOrder: z.number().optional().describe("The position of the issue in its column on the board view"),
  subIssueSortOrder: z.number().optional().describe("The position of the issue in parent's sub-issue list"),
  prioritySortOrder: z.number().optional().describe("[ALPHA] The position of the issue when ordered by priority"),

  // Templates and automation
  lastAppliedTemplateId: z.string().optional().describe("The ID of the last template applied to the issue"),
  autoClosedByParentClosing: z.boolean().optional()
    .describe("Whether the issue was automatically closed because its parent issue was closed"),
  trashed: z.boolean().optional().describe("Whether the issue has been trashed"),
});

export const GetIssueParams = z.object({
  issueId: z.string(),
});

export const SearchIssuesParams = z.object({
  query: z.string().describe("Search query string"),
  teamId: z.string().optional(),
  limit: z.number().max(5).describe("Number of results to return (default: 1)"),
});

export const ListTeamsParams = z.object({
  limit: z.number().max(20).describe("Number of teams to return (default 3)"),
});

// Add these type definitions before the parameter schemas
export const StringComparator = z.object({
  eq: z.string().optional(),
  neq: z.string().optional(),
  in: z.array(z.string()).optional(),
  nin: z.array(z.string()).optional(),
  contains: z.string().optional(),
  notContains: z.string().optional(),
  startsWith: z.string().optional(),
  notStartsWith: z.string().optional(),
  endsWith: z.string().optional(),
  notEndsWith: z.string().optional(),
  containsIgnoreCase: z.string().optional(),
  notContainsIgnoreCase: z.string().optional(),
  startsWithIgnoreCase: z.string().optional(),
  notStartsWithIgnoreCase: z.string().optional(),
  endsWithIgnoreCase: z.string().optional(),
  notEndsWithIgnoreCase: z.string().optional(),
});

export const DateComparator = z.object({
  eq: z.string().optional(),
  neq: z.string().optional(),
  gt: z.string().optional(),
  gte: z.string().optional(),
  lt: z.string().optional(),
  lte: z.string().optional(),
  in: z.array(z.string()).optional(),
  nin: z.array(z.string()).optional(),
});

export const NumberComparator = z.object({
  eq: z.number().optional(),
  neq: z.number().optional(),
  gt: z.number().optional(),
  gte: z.number().optional(),
  lt: z.number().optional(),
  lte: z.number().optional(),
  in: z.array(z.number()).optional(),
  nin: z.array(z.number()).optional(),
});

export const IdComparator = z.object({
  eq: z.string().optional(),
  neq: z.string().optional(),
  in: z.array(z.string()).optional(),
  nin: z.array(z.string()).optional(),
});

export const WorkflowStateFilter = z.object({
  createdAt: DateComparator.optional(),
  description: StringComparator.optional(),
  id: IdComparator.optional(),
  name: StringComparator.optional(),
  position: NumberComparator.optional(),
  type: StringComparator.optional(),
  updatedAt: DateComparator.optional(),
});

export const AdvancedSearchIssuesParams = z.object({
  // Text search
  query: z.string().optional().describe("Search in title and description"),
  title: z.string().optional().describe("Filter by exact or partial title match"),
  description: z.string().optional().describe("Filter by description content"),

  // Basic filters
  teamId: z.string().optional().describe("Filter by team ID"),
  assigneeId: z.string().optional().describe("Filter by assignee user ID"),
  creatorId: z.string().optional().describe("Filter by creator user ID"),
  priority: z.number().min(0).max(4).optional()
    .describe("0 = No priority, 1 = Urgent, 2 = High, 3 = Normal, 4 = Low"),

  // Status and state
  stateId: z.string().optional().describe("Filter by specific workflow state ID (simplified)"),

  // Dates
  createdAfter: z.string().optional().describe("Issues created after this ISO datetime"),
  createdBefore: z.string().optional().describe("Issues created before this ISO datetime"),
  updatedAfter: z.string().optional().describe("Issues updated after this ISO datetime"),
  updatedBefore: z.string().optional().describe("Issues updated before this ISO datetime"),
  completedAfter: z.string().optional().describe("Issues completed after this ISO datetime"),
  completedBefore: z.string().optional().describe("Issues completed before this ISO datetime"),
  dueDate: z.string().optional().describe("Filter by due date (YYYY-MM-DD format)"),
  dueDateAfter: z.string().optional().describe("Due date after (YYYY-MM-DD format)"),
  dueDateBefore: z.string().optional().describe("Due date before (YYYY-MM-DD format)"),
  startedAfter: z.string().optional().describe("Issues started after this ISO datetime"),
  startedBefore: z.string().optional().describe("Issues started before this ISO datetime"),

  // Relationships
  projectId: z.string().optional().describe("Filter by project ID"),
  parentId: z.string().optional().describe("Filter by parent issue ID"),
  subscriberId: z.string().optional().describe("Filter by subscriber user ID"),
  hasBlockedBy: z.boolean().optional().describe("Issues that are blocked by others"),
  hasBlocking: z.boolean().optional().describe("Issues that are blocking others"),
  hasDuplicates: z.boolean().optional().describe("Issues that have duplicates"),

  // Labels and estimates
  labelIds: z.array(z.string()).optional().describe("Filter by one or more label IDs"),
  estimate: z.number().optional().describe("Filter by issue estimate points"),

  // Other filters
  number: z.number().optional().describe("Filter by issue number"),
  snoozedById: z.string().optional().describe("Filter by user who snoozed the issue"),
  snoozedUntilAfter: z.string().optional().describe("Issues snoozed until after this ISO datetime"),
  snoozedUntilBefore: z.string().optional().describe("Issues snoozed until before this ISO datetime"),

  // Result options
  orderBy: z.enum(["createdAt", "updatedAt", "priority", "dueDate"])
    .optional()
    .describe("Sort order for results"),
  limit: z.number().max(10)
    .describe("Number of results to return (default: 2, max: 10)"),
});

// Modify SearchUsersParams schema to allow more specific search parameters
export const SearchUsersParams = z.object({
  email: z.string().optional().describe("Search by exact email address"),
  displayName: z.string().optional().describe("Search by display name"),
  limit: z
    .number()
    .max(10)
    .describe("Number of results to return (default: 5)"),
}).refine(
  data => (data.email && !data.displayName) || (!data.email && data.displayName),
  {
    message: "Provide either email OR displayName, not both"
  }
);

// Add new Project Parameter Schemas
export const ProjectParams = z.object({
  name: z.string().describe("The name of the project"),
  teamIds: z
    .array(z.string())
    .describe("The identifiers of the teams this project is associated with"),
  description: z
    .string()
    .optional()
    .describe("The description for the project"),
  content: z.string().optional().describe("The project content as markdown"),
  color: z.string().optional().describe("The color of the project"),
  icon: z.string().optional().describe("The icon of the project"),
  leadId: z.string().optional().describe("The identifier of the project lead"),
  memberIds: z
    .array(z.string())
    .optional()
    .describe("The identifiers of the members of this project"),
  priority: z
    .number()
    .min(0)
    .max(4)
    .optional()
    .describe(
      "The priority of the project. 0 = No priority, 1 = Urgent, 2 = High, 3 = Normal, 4 = Low"
    ),
  sortOrder: z
    .number()
    .optional()
    .describe("The sort order for the project within shared views"),
  prioritySortOrder: z
    .number()
    .optional()
    .describe(
      "[ALPHA] The sort order for the project within shared views, when ordered by priority"
    ),
  startDate: z
    .string()
    .optional()
    .describe("The planned start date of the project (TimelessDate format)"),
  targetDate: z
    .string()
    .optional()
    .describe("The planned target date of the project (TimelessDate format)"),
  statusId: z.string().optional().describe("The ID of the project status"),
  state: z
    .string()
    .optional()
    .describe("[DEPRECATED] The state of the project"),
  id: z.string().optional().describe("The identifier in UUID v4 format"),
  convertedFromIssueId: z
    .string()
    .optional()
    .describe("The ID of the issue from which that project is created"),
  lastAppliedTemplateId: z
    .string()
    .optional()
    .describe("The ID of the last template applied to the project"),
});

export const UpdateProjectParams = z.object({
  projectId: z.string().describe("The ID of the project to update"),
  name: z.string().optional(),
  description: z.string().optional(),
  state: z
    .enum(["planned", "started", "paused", "completed", "canceled"])
    .optional(),
  startDate: z.string().optional(),
  targetDate: z.string().optional(),
  sortOrder: z.number().optional(),
  icon: z.string().optional(),
});

export const GetProjectParams = z.object({
  projectId: z.string(),
});

export const SearchProjectsParams = z.object({
  // Text search
  query: z.string().optional().describe("Search in project name and content"),
  name: z.string().optional().describe("Filter by exact or partial project name"),

  // Basic filters
  teamId: z.string().optional().describe("Filter by team ID"),
  creatorId: z.string().optional().describe("Filter by creator user ID"),
  leadId: z.string().optional().describe("Filter by lead user ID"),
  priority: z.number().min(0).max(4).optional()
    .describe("0 = No priority, 1 = Urgent, 2 = High, 3 = Normal, 4 = Low"),

  // Status and state
  health: z.string().optional().describe("Filter by project health status"),
  state: z.string().optional().describe("[DEPRECATED] Filter by project state"),
  status: z.string().optional().describe("Filter by project status ID"),

  // Dates
  startDate: z.string().optional().describe("Filter by start date"),
  targetDate: z.string().optional().describe("Filter by target date"),
  createdAfter: z.string().optional().describe("Projects created after this ISO datetime"),
  createdBefore: z.string().optional().describe("Projects created before this ISO datetime"),
  updatedAfter: z.string().optional().describe("Projects updated after this ISO datetime"),
  updatedBefore: z.string().optional().describe("Projects updated before this ISO datetime"),
  completedAfter: z.string().optional().describe("Projects completed after this ISO datetime"),
  completedBefore: z.string().optional().describe("Projects completed before this ISO datetime"),
  canceledAfter: z.string().optional().describe("Projects canceled after this ISO datetime"),
  canceledBefore: z.string().optional().describe("Projects canceled before this ISO datetime"),

  // Relationships
  hasBlockedBy: z.boolean().optional().describe("Projects that are blocked by others"),
  hasBlocking: z.boolean().optional().describe("Projects that are blocking others"),
  hasRelated: z.boolean().optional().describe("Projects that have related items"),
  hasViolatedDependencies: z.boolean().optional().describe("Projects with violated dependencies"),

  // Result options
  orderBy: z.enum(["createdAt", "updatedAt", "priority", "targetDate"])
    .optional()
    .describe("Sort order for results"),
  limit: z.number().max(10).describe("Number of results to return (default: 1)"),
});

// Add new ListProjectsParams schema after other params
export const ListProjectsParams = z.object({
  teamId: z.string().optional().describe("Filter projects by team ID"),
  limit: z
    .number()
    .max(20)
    .describe("Number of projects to return (default: 10)"),
  state: z
    .enum(["planned", "started", "paused", "completed", "canceled"])
    .optional()
    .describe("Filter projects by state"),
});

// Add after other parameter schemas
export const CreateCommentParams = z.object({
  issueId: z.string().describe("The ID of the issue to comment on"),
  body: z.string().describe("The comment text in markdown format"),
});

export const ListCommentsParams = z.object({
  issueId: z.string().describe("The ID of the issue to get comments from"),
  limit: z.number().max(20).describe("Number of comments to return (default: 10)"),
});

// Add new document parameter schemas
export const CreateDocumentParams = z.object({
  title: z.string().describe("The title of the document"),
  content: z.string().describe("The content of the document in markdown format"),
  icon: z.string().optional().describe("The icon of the document"),
  organizationId: z.string().optional().describe("The organization ID"),
  projectId: z.string().optional().describe("The project ID to link the document to"),
});

export const UpdateDocumentParams = z.object({
  documentId: z.string().describe("The ID of the document to update"),
  title: z.string().optional().describe("The new title of the document"),
  content: z.string().optional().describe("The new content in markdown format"),
  icon: z.string().optional().describe("The new icon of the document"),
});

export const GetDocumentParams = z.object({
  documentId: z.string().describe("The ID of the document to retrieve"),
});

export const SearchDocumentsParams = z.object({
  query: z.string().describe("Search query string"),
  projectId: z.string().optional().describe("Filter by project ID"),
  limit: z.number().max(10).describe("Number of results to return (default: 5)"),
});

interface SimpleIssue {
  id: string;           // The internal UUID of the issue (e.g., "123e4567-e89b-12d3-a456-426614174000")
  identifier: string;   // The human-readable identifier (e.g., "XCE-205")
  title: string;
  status: string;
  statusId: string;
  priority: number;
  assignee?: string;
  dueDate?: string;
  labels?: string[];
}

interface SimpleTeam {
  id: string;
  name: string;
  key: string;
}

interface SimpleUser {
  id: string;
  name: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
}

interface SimpleProject {
  id: string;
  name: string;
  state: string;
  startDate?: string;
  targetDate?: string;
  description?: string;
  teamIds: string[];
  priority?: number;
  leadId?: string;
  memberIds?: string[];
  color?: string;
  icon?: string;
  statusId?: string;
}

// Add new document interface
interface SimpleDocument {
  id: string;
  title: string;
  content: string;
  icon?: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

// Add after other interfaces
interface SimpleComment {
  id: string;
  body: string;
  user?: {
    id: string;
    name: string;
  };
  createdAt: string;
}

function formatIssue(issue: any): SimpleIssue {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.state?.name || "Unknown",
    statusId: issue.state?.id,
    priority: issue.priority,
    assignee: issue.assignee?.name,
    dueDate: issue.dueDate,
    labels: issue.labels?.nodes?.map((l: any) => ({
      name: l.name,
      id: l.id
    })) || [],
  };
}

// Add after existing formatIssue function
function formatProject(project: any): SimpleProject {
  return {
    id: project.id,
    name: project.name,
    state: project.state,
    startDate: project.startDate,
    targetDate: project.targetDate,
    description: project.description,
    teamIds: project.teams?.nodes?.map((t: any) => t.id) || [],
    priority: project.priority,
    leadId: project.lead?.id,
    memberIds: project.members?.nodes?.map((m: any) => m.id) || [],
    color: project.color,
    icon: project.icon,
    statusId: project.status?.id,
  };
}

// Add new document formatting function
function formatDocument(doc: any): SimpleDocument {
  return {
    id: doc.id,
    title: doc.title,
    content: doc.content,
    icon: doc.icon,
    url: doc.url,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// Add after other formatting functions
function formatComment(comment: any): SimpleComment {
  return {
    id: comment.id,
    body: comment.body,
    user: comment.user ? {
      id: comment.user.id,
      name: comment.user.name,
    } : undefined,
    createdAt: comment.createdAt,
  };
}

// API Functions
async function createIssue(
  client: LinearClient,
  params: z.infer<typeof IssueParams>
) {
  try {
    return await client.createIssue(params);
  } catch (error) {
    return `Error: ${error}`;
  }
}

async function updateIssue(
  client: LinearClient,
  params: z.infer<typeof UpdateIssueParams>
) {
  try {
    const { issueId, ...updateData } = params;

    // Create a new object for the properly typed data
    const formattedData: any = { ...updateData };

    // Convert date strings to proper format if provided
    if (formattedData.dueDate) {
      // Due date should be YYYY-MM-DD format
      formattedData.dueDate = formattedData.dueDate.split('T')[0];
    }

    if (formattedData.snoozedUntilAt) {
      // Convert to Date object for the API
      formattedData.snoozedUntilAt = new Date(formattedData.snoozedUntilAt);
    }

    // Remove any undefined values to avoid API errors
    Object.keys(formattedData).forEach(key => {
      if (formattedData[key] === undefined) {
        delete formattedData[key];
      }
    });

    return await client.updateIssue(issueId, formattedData);
  } catch (error) {
    return `Error: ${error}`;
  }
}

async function getIssue(
  client: LinearClient,
  { issueId }: z.infer<typeof GetIssueParams>
) {
  try {
    return await client.issue(issueId);
  } catch (error) {
    return `Error: ${error}`;
  }
}

async function searchIssues(
  client: LinearClient,
  { query, teamId, limit }: z.infer<typeof SearchIssuesParams>
) {
  try {
    const searchParams: any = { first: limit };
    if (teamId) {
      searchParams.filter = { team: { id: { eq: teamId } } };
    }

    const issues = await client.issues({
      ...searchParams,
      filter: {
        or: [
          { title: { containsIgnoreCase: query } },
          { description: { containsIgnoreCase: query } },
        ],
      },
    });
    return issues.nodes.map(formatIssue);
  } catch (error) {
    return `Error: ${error}`;
  }
}

async function listTeams(
  client: LinearClient,
  { limit }: z.infer<typeof ListTeamsParams>
) {
  try {
    const teams = await client.teams({ first: limit });
    return teams.nodes.map(
      (team): SimpleTeam => ({
        id: team.id,
        name: team.name,
        key: team.key,
      })
    );
  } catch (error) {
    return `Error: ${error}`;
  }
}

async function advancedSearchIssues(
  client: LinearClient,
  params: z.infer<typeof AdvancedSearchIssuesParams>
) {
  try {
    const filter: any = {};

    // Text search filters
    if (params.query) {
      filter.or = [
        { title: { containsIgnoreCase: params.query } },
        { description: { containsIgnoreCase: params.query } },
      ];
    }
    if (params.title) filter.title = { containsIgnoreCase: params.title };
    if (params.description) filter.description = { containsIgnoreCase: params.description };

    // Basic filters
    if (params.teamId) filter.team = { id: { eq: params.teamId } };
    if (params.assigneeId) filter.assignee = { id: { eq: params.assigneeId } };
    if (params.creatorId) filter.creator = { id: { eq: params.creatorId } };
    if (params.priority !== undefined) filter.priority = { eq: params.priority };

    // Status and state
    if (params.stateId) {
      filter.state = { id: { eq: params.stateId } };
    }

    // Date filters
    if (params.createdAfter) filter.createdAt = { gt: params.createdAfter };
    if (params.createdBefore) filter.createdAt = { lt: params.createdBefore };
    if (params.updatedAfter) filter.updatedAt = { gt: params.updatedAfter };
    if (params.updatedBefore) filter.updatedAt = { lt: params.updatedBefore };
    if (params.completedAfter) filter.completedAt = { gt: params.completedAfter };
    if (params.completedBefore) filter.completedAt = { lt: params.completedBefore };
    if (params.startedAfter) filter.startedAt = { gt: params.startedAfter };
    if (params.startedBefore) filter.startedAt = { lt: params.startedBefore };

    // Due date filters
    if (params.dueDate) filter.dueDate = { eq: params.dueDate };
    if (params.dueDateAfter) filter.dueDate = { gt: params.dueDateAfter };
    if (params.dueDateBefore) filter.dueDate = { lt: params.dueDateBefore };

    // Relationship filters
    if (params.projectId) filter.project = { id: { eq: params.projectId } };
    if (params.parentId) filter.parent = { id: { eq: params.parentId } };
    if (params.subscriberId) filter.subscribers = { some: { id: { eq: params.subscriberId } } };
    if (params.hasBlockedBy) filter.hasBlockedByRelations = { eq: true };
    if (params.hasBlocking) filter.hasBlockingRelations = { eq: true };
    if (params.hasDuplicates) filter.hasDuplicateRelations = { eq: true };

    // Labels
    if (params.labelIds?.length) {
      filter.labels = { some: { id: { in: params.labelIds } } };
    }

    // Other filters
    if (params.estimate !== undefined) filter.estimate = { eq: params.estimate };
    if (params.number !== undefined) filter.number = { eq: params.number };
    if (params.snoozedById) filter.snoozedBy = { id: { eq: params.snoozedById } };
    if (params.snoozedUntilAfter) filter.snoozedUntilAt = { gt: params.snoozedUntilAfter };
    if (params.snoozedUntilBefore) filter.snoozedUntilAt = { lt: params.snoozedUntilBefore };

    const issues = await client.issues({
      first: params.limit,
      filter,
      orderBy: params.orderBy || "updatedAt" as any,
    });

    return issues.nodes.map(formatIssue);
  } catch (error) {
    return `Error: ${error}`;
  }
}

// Modify searchUsers function to allow more specific search parameters
async function searchUsers(
  client: LinearClient,
  params: z.infer<typeof SearchUsersParams>
) {
  try {
    let filter: any = {};

    if (params.email) {
      filter = { email: { eq: params.email } };
    } else if (params.displayName) {
      filter = { displayName: { containsIgnoreCase: params.displayName } };
    }

    const users = await client.users({
      filter,
      first: params.limit,
    });

    return users.nodes.map(
      (user): SimpleUser => ({
        id: user.id,
        name: user.name,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      })
    );
  } catch (error) {
    return `Error: ${error}`;
  }
}

// Add new Project API Functions
async function createProject(
  client: LinearClient,
  params: z.infer<typeof ProjectParams>
) {
  try {
    return await client.createProject(params);
  } catch (error) {
    return `Error: ${error}`;
  }
}

async function updateProject(
  client: LinearClient,
  params: z.infer<typeof UpdateProjectParams>
) {
  try {
    const { projectId, ...updateData } = params;
    return await client.updateProject(projectId, updateData);
  } catch (error) {
    return `Error: ${error}`;
  }
}

async function getProject(
  client: LinearClient,
  { projectId }: z.infer<typeof GetProjectParams>
) {
  try {
    return await client.project(projectId);
  } catch (error) {
    return `Error: ${error}`;
  }
}

// Modify searchProjects function to handle empty queries
async function searchProjects(
  client: LinearClient,
  params: z.infer<typeof SearchProjectsParams>
) {
  try {
    const filter: any = {};

    // Text search filters
    if (params.query) {
      filter.or = [
        { name: { containsIgnoreCase: params.query } },
        { searchableContent: { contains: params.query } }
      ];
    }
    if (params.name) {
      filter.name = { containsIgnoreCase: params.name };
    }

    // Basic filters
    if (params.teamId) {
      filter.accessibleTeams = { some: { id: { eq: params.teamId } } };
    }
    if (params.creatorId) {
      filter.creator = { id: { eq: params.creatorId } };
    }
    if (params.leadId) {
      filter.lead = { id: { eq: params.leadId } };
    }
    if (params.priority !== undefined) {
      filter.priority = { eq: params.priority };
    }

    // Status and state filters
    if (params.health) {
      filter.health = { eq: params.health };
    }
    if (params.state) {
      filter.state = { eq: params.state };
    }
    if (params.status) {
      filter.status = { id: { eq: params.status } };
    }

    // Date filters
    if (params.startDate) {
      filter.startDate = { eq: params.startDate };
    }
    if (params.targetDate) {
      filter.targetDate = { eq: params.targetDate };
    }
    if (params.createdAfter || params.createdBefore) {
      filter.createdAt = {
        ...(params.createdAfter && { gt: params.createdAfter }),
        ...(params.createdBefore && { lt: params.createdBefore })
      };
    }
    if (params.updatedAfter || params.updatedBefore) {
      filter.updatedAt = {
        ...(params.updatedAfter && { gt: params.updatedAfter }),
        ...(params.updatedBefore && { lt: params.updatedBefore })
      };
    }
    if (params.completedAfter || params.completedBefore) {
      filter.completedAt = {
        ...(params.completedAfter && { gt: params.completedAfter }),
        ...(params.completedBefore && { lt: params.completedBefore })
      };
    }
    if (params.canceledAfter || params.canceledBefore) {
      filter.canceledAt = {
        ...(params.canceledAfter && { gt: params.canceledAfter }),
        ...(params.canceledBefore && { lt: params.canceledBefore })
      };
    }

    // Relationship filters
    if (params.hasBlockedBy) {
      filter.hasBlockedByRelations = { eq: true };
    }
    if (params.hasBlocking) {
      filter.hasBlockingRelations = { eq: true };
    }
    if (params.hasRelated) {
      filter.hasRelatedRelations = { eq: true };
    }
    if (params.hasViolatedDependencies) {
      filter.hasViolatedRelations = { eq: true };
    }

    const projects = await client.projects({
      first: params.limit,
      filter,
      orderBy: params.orderBy || "updatedAt" as any,
    });

    return projects.nodes.map(formatProject);
  } catch (error) {
    return `Error: ${error}`;
  }
}

// Add new listProjects function
async function listProjects(
  client: LinearClient,
  { teamId, limit, state }: z.infer<typeof ListProjectsParams>
) {
  try {
    const filter: any = {};

    if (teamId) {
      filter.team = { id: { eq: teamId } };
    }

    if (state) {
      filter.state = { eq: state };
    }

    const projects = await client.projects({
      first: limit,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      orderBy: "updatedAt" as any,
    });

    return projects.nodes.map(formatProject);
  } catch (error) {
    return `Error: ${error}`;
  }
}

// Add new comment API functions before the main manager function
async function createComment(
  client: LinearClient,
  params: z.infer<typeof CreateCommentParams>
) {
  try {
    const { issueId, body } = params;
    const comment = await client.createComment({
      issueId,
      body,
    });
    return formatComment(comment);
  } catch (error) {
    return `Error: ${error}`;
  }
}

async function listComments(
  client: LinearClient,
  params: z.infer<typeof ListCommentsParams>
) {
  try {
    const { issueId, limit } = params;
    const issue = await client.issue(issueId);
    const comments = await issue.comments({
      first: limit,
      orderBy: "createdAt" as any,
    });
    return comments.nodes.map(formatComment);
  } catch (error) {
    return `Error: ${error}`;
  }
}

// Add new document API functions before the main manager function
async function createDocument(
  client: LinearClient,
  params: z.infer<typeof CreateDocumentParams>
) {
  try {
    const document = await client.createDocument(params);
    return formatDocument(document);
  } catch (error) {
    return `Error: ${error}`;
  }
}

async function updateDocument(
  client: LinearClient,
  params: z.infer<typeof UpdateDocumentParams>
) {
  try {
    const { documentId, ...updateData } = params;
    const document = await client.updateDocument(documentId, updateData);
    return formatDocument(document);
  } catch (error) {
    return `Error: ${error}`;
  }
}

async function getDocument(
  client: LinearClient,
  { documentId }: z.infer<typeof GetDocumentParams>
) {
  try {
    const document = await client.document(documentId);
    return formatDocument(document);
  } catch (error) {
    return `Error: ${error}`;
  }
}

async function searchDocuments(
  client: LinearClient,
  params: z.infer<typeof SearchDocumentsParams>
) {
  try {
    const filter: any = {
      or: [
        { title: { containsIgnoreCase: params.query } },
        { content: { containsIgnoreCase: params.query } },
      ],
    };

    if (params.projectId) {
      filter.project = { id: { eq: params.projectId } };
    }

    const documents = await client.documents({
      first: params.limit,
      filter,
      orderBy: "updatedAt" as any,
    });

    return documents.nodes.map(formatDocument);
  } catch (error) {
    return `Error: ${error}`;
  }
}

// Main manager function
export const LinearManagerParams = z.object({
  request: z
    .string()
    .describe("User's request regarding Linear project management"),
});
export type LinearManagerParams = z.infer<typeof LinearManagerParams>;

export async function linearManager(
  { request }: LinearManagerParams,
  context_message: Message
) {

  const userConfig = context_message.author.config;

  //   console.log("User config", userConfig);

  const linearApiKey = userConfig?.identities.find(
    (i) => i.platform === "linear_key"
  )?.id;

  //   console.log("Linear API Key", linearApiKey);

  const linearEmail = userConfig?.identities.find(
    (i) => i.platform === "linear_email"
  )?.id;

  if (!linearApiKey) {
    return {
      response: "Please configure your Linear API key to use this tool.",
    };
  }

  const client = new LinearClient({ apiKey: linearApiKey });


  const linear_tools: RunnableToolFunction<any>[] = [
    zodFunction({
      function: (params) => createIssue(client, params),
      name: "linearCreateIssue",
      schema: IssueParams,
      description: "Create a new issue in Linear",
    }),
    zodFunction({
      function: (params) => updateIssue(client, params),
      name: "linearUpdateIssue",
      schema: UpdateIssueParams,
      description: "Update an existing issue in Linear",
    }),
    zodFunction({
      function: (params) => getIssue(client, params),
      name: "linearGetIssue",
      schema: GetIssueParams,
      description: "Get details of a specific issue",
    }),
    zodFunction({
      function: (params) => searchUsers(client, params),
      name: "linearSearchUsers",
      schema: SearchUsersParams,
      description:
        "Search for users across the workspace by name, display name, or email. Use display name for better results.",
    }),
    zodFunction({
      function: (params) => searchIssues(client, params),
      name: "linearSearchIssues",
      schema: SearchIssuesParams,
      description:
        "Search for issues in Linear using a query string. Optionally filter by team and limit results.",
    }),
    zodFunction({
      function: (params) => listTeams(client, params),
      name: "linearListTeams",
      schema: ListTeamsParams,
      description: "List all teams in the workspace with optional limit",
    }),
    zodFunction({
      function: (params) => advancedSearchIssues(client, params),
      name: "linearAdvancedSearchIssues",
      schema: AdvancedSearchIssuesParams,
      description: `Search for issues with advanced filters including:
- Status (backlog, todo, in_progress, done, canceled)
- Assignee
- Priority
- Date ranges for:
  * Updated time
  * Created time
  * Completed time
Use ISO datetime format (e.g., "2024-01-18T00:00:00Z") for date filters.
Can find issues updated, created, or completed within specific time periods.`,
    }),
    zodFunction({
      function: (params) => createProject(client, params),
      name: "linearCreateProject",
      schema: ProjectParams,
      description: "Create a new project in Linear",
    }),
    zodFunction({
      function: (params) => updateProject(client, params),
      name: "linearUpdateProject",
      schema: UpdateProjectParams,
      description: "Update an existing project in Linear",
    }),
    zodFunction({
      function: (params) => getProject(client, params),
      name: "linearGetProject",
      schema: GetProjectParams,
      description: "Get details of a specific project",
    }),
    zodFunction({
      function: (params) => searchProjects(client, params),
      name: "linearSearchProjects",
      schema: SearchProjectsParams,
      description:
        "Search for projects in Linear using a query string. Optionally filter by team and limit results.",
    }),
    zodFunction({
      function: (params) => listProjects(client, params),
      name: "linearListProjects",
      schema: ListProjectsParams,
      description:
        "List projects in Linear, optionally filtered by team and state. Returns most recently updated projects first.",
    }),
    zodFunction({
      function: (params) => createComment(client, params),
      name: "linearCreateComment",
      schema: CreateCommentParams,
      description: "Create a new comment on a Linear issue",
    }),
    zodFunction({
      function: (params) => listComments(client, params),
      name: "linearListComments",
      schema: ListCommentsParams,
      description: "List comments on a Linear issue",
    }),
    zodFunction({
      function: (params) => createDocument(client, params),
      name: "linearCreateDocument",
      schema: CreateDocumentParams,
      description: "Create a new document in Linear",
    }),
    zodFunction({
      function: (params) => updateDocument(client, params),
      name: "linearUpdateDocument",
      schema: UpdateDocumentParams,
      description: "Update an existing document in Linear",
    }),
    zodFunction({
      function: (params) => getDocument(client, params),
      name: "linearGetDocument",
      schema: GetDocumentParams,
      description: "Get details of a specific document",
    }),
    zodFunction({
      function: (params) => searchDocuments(client, params),
      name: "linearSearchDocuments",
      schema: SearchDocumentsParams,
      description: "Search for documents in Linear using a query string",
    }),
  ];


  const organization = await client.organization
  const workspace = organization?.name

  // fetch all labels available in each team
  const teams = await client.teams({ first: 10 });
  const teamLabels = await client.issueLabels();

  // list all the possible states of issues
  const states = await client.workflowStates();
  const state_values = states.nodes.map((state) => ({
    id: state.id,
    name: state.name,
  }));

  const organizationContext = `Organization:
Name: ${workspace}
Id: ${organization?.id}
`;

  // Only include teams and labels in the context if they exist
  const teamsContext =
    teams.nodes.length > 0
      ? `Teams:\n${teams.nodes.map((team) => ` - ${team.name} id: ${team.id}`).join("\n")}`
      : "";

  const labelsContext =
    teamLabels.nodes.length > 0
      ? `All Labels:\n${teamLabels.nodes
        .map((label) => ` - ${label.name} (${label.color}) id: ${label.id}`)
        .join("\n")}`
      : "";

  const issueStateContext =
    state_values.length > 0
      ? `All Issue States:\n${state_values
        .map((state) => ` - ${state.name} id: ${state.id}`)
        .join("\n")}`
      : "";

  const workspaceContext = [organizationContext, teamsContext, labelsContext, issueStateContext]
    .filter(Boolean)
    .join("\n\n");

  const userDetails = await client.users({ filter: { email: { eq: linearEmail } } });

  const response = await ask({
    model: "gpt-4o",
    prompt: `You are a Linear project manager.

Your job is to understand the user's request and manage issues, teams, and projects using the available tools.

Important note about Linear issue identification:
- issueId: A UUID that uniquely identifies an issue internally (e.g., "123e4567-e89b-12d3-a456-426614174000")
- identifier: A human-readable issue reference (e.g., "XCE-205", "ENG-123")
When referring to issues in responses, always use the identifier format for better readability.

----
${memory_manager_guide("linear_manager", context_message.author.id)}
----

${workspaceContext
        ? `Here is some more context on current linear workspace:\n${workspaceContext}`
        : ""
      }

The user you are currently assisting has the following details (No need to search if the user is asking for their own related issues/projects):
- Name: ${userConfig?.name}
- Linear Email: ${linearEmail}
- Linear User ID: ${userDetails.nodes[0]?.id}

When responding make sure to link the issues when returning the value.
linear issue links look like: \`https://linear.app/xcelerator/issue/XCE-205\`
Where \`XCE-205\` is the identifier (not the issueId) and \`xcelerator\` is the team name.
`,
    message: request,
    seed: `linear-${context_message.channelId}`,
    tools: linear_tools.concat(
      memory_manager_init(context_message, "linear_manager")
    ) as any,
  });

  return { response };
}

export const linear_manager_tool = (context_message: Message) =>
  zodFunction({
    function: (args) => linearManager(args, context_message),
    name: "linear_manager",
    schema: LinearManagerParams,
    description: `Linear Issue Manager.

This tool allows you to create, update, close, or assign issues in Linear.

Provide detailed information to perform the requested action.

Use this when user explicitly asks for Linear/project management.`,
  });
