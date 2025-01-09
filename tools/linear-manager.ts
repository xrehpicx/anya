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
  priority: z.number().optional(),
  labelIds: z.array(z.string()).optional(),
});

export const UpdateIssueParams = z.object({
  issueId: z.string().describe("The ID of the issue to update"),
  title: z.string().optional().describe("The issue title"),
  description: z
    .string()
    .optional()
    .describe("The issue description in markdown format"),
  stateId: z.string().optional().describe("The team state/status of the issue"),
  assigneeId: z
    .string()
    .optional()
    .describe("The identifier of the user to assign the issue to"),
  priority: z
    .number()
    .min(0)
    .max(4)
    .optional()
    .describe(
      "The priority of the issue. 0 = No priority, 1 = Urgent, 2 = High, 3 = Normal, 4 = Low"
    ),
  addedLabelIds: z
    .array(z.string())
    .optional()
    .describe("The identifiers of the issue labels to be added to this issue"),
  removedLabelIds: z
    .array(z.string())
    .optional()
    .describe(
      "The identifiers of the issue labels to be removed from this issue"
    ),
  labelIds: z
    .array(z.string())
    .optional()
    .describe(
      "The complete set of label IDs to set on the issue (replaces existing labels)"
    ),
  autoClosedByParentClosing: z
    .boolean()
    .optional()
    .describe(
      "Whether the issue was automatically closed because its parent issue was closed"
    ),
  boardOrder: z
    .number()
    .optional()
    .describe("The position of the issue in its column on the board view"),
  dueDate: z
    .string()
    .optional()
    .describe("The date at which the issue is due (TimelessDate format)"),
  parentId: z
    .string()
    .optional()
    .describe("The identifier of the parent issue"),
  projectId: z
    .string()
    .optional()
    .describe("The project associated with the issue"),
  sortOrder: z
    .number()
    .optional()
    .describe("The position of the issue related to other issues"),
  subIssueSortOrder: z
    .number()
    .optional()
    .describe("The position of the issue in parent's sub-issue list"),
  teamId: z
    .string()
    .optional()
    .describe("The identifier of the team associated with the issue"),
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

export const AdvancedSearchIssuesParams = z.object({
  query: z.string().optional(),
  teamId: z.string().optional(),
  assigneeId: z.string().optional(),
  status: z
    .enum(["backlog", "todo", "in_progress", "done", "canceled"])
    .optional(),
  priority: z.number().min(0).max(4).optional(),
  orderBy: z
    .enum(["createdAt", "updatedAt"])
    .optional()
    .describe("Order by, defaults to updatedAt"),
  limit: z
    .number()
    .max(10)
    .describe("Number of results to return (default: 5)"),
});

export const SearchUsersParams = z.object({
  query: z.string().describe("Search query for user names"),
  limit: z
    .number()
    .max(10)
    .describe("Number of results to return (default: 5)"),
});

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
  query: z.string().describe("Search query string"),
  teamId: z.string().optional(),
  limit: z.number().max(5).describe("Number of results to return (default: 1)"),
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

interface SimpleIssue {
  id: string;
  title: string;
  status: string;
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

function formatIssue(issue: any): SimpleIssue {
  return {
    id: issue.id,
    title: issue.title,
    status: issue.state?.name || "Unknown",
    priority: issue.priority,
    assignee: issue.assignee?.name,
    dueDate: issue.dueDate,
    labels: issue.labels?.nodes?.map((l: any) => l.name) || [],
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
    return await client.updateIssue(issueId, updateData);
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
    if (params.teamId) filter.team = { id: { eq: params.teamId } };
    if (params.assigneeId) filter.assignee = { id: { eq: params.assigneeId } };
    if (params.status) filter.state = { type: { eq: params.status } };
    if (params.priority) filter.priority = { eq: params.priority };
    if (params.query) {
      filter.or = [
        { title: { containsIgnoreCase: params.query } },
        { description: { containsIgnoreCase: params.query } },
      ];
    }

    const issues = await client.issues({
      first: params.limit,
      filter,
      orderBy: params.orderBy || ("updatedAt" as any),
    });

    return issues.nodes.map(formatIssue);
  } catch (error) {
    return `Error: ${error}`;
  }
}

async function searchUsers(
  client: LinearClient,
  { query, limit }: z.infer<typeof SearchUsersParams>
) {
  try {
    const users = await client.users({
      filter: {
        or: [
          { name: { containsIgnoreCase: query } },
          { displayName: { containsIgnoreCase: query } },
          { email: { containsIgnoreCase: query } },
        ],
      },
      first: limit,
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
  { query, teamId, limit }: z.infer<typeof SearchProjectsParams>
) {
  try {
    const searchParams: any = { first: limit };
    const filter: any = {};

    if (teamId) {
      filter.team = { id: { eq: teamId } };
    }

    if (query) {
      filter.or = [{ name: { containsIgnoreCase: query } }];
    }

    if (Object.keys(filter).length > 0) {
      searchParams.filter = filter;
    }

    const projects = await client.projects(searchParams);
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
  console.log(
    "Context message",
    context_message.author,
    context_message.getUserRoles()
  );
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
      description:
        "Search for issues with advanced filters including status, assignee, and priority",
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
  ];

  // fetch all labels available in each team
  const teams = await client.teams({ first: 10 });
  const teamLabels = await client.issueLabels();

  // list all the possible states of issues
  const states = await client.workflowStates();
  const state_values = states.nodes.map((state) => ({
    id: state.id,
    name: state.name,
  }));

  // Only include teams and labels in the context if they exist
  const teamsContext =
    teams.nodes.length > 0
      ? `Teams:\n${teams.nodes.map((team) => ` - ${team.name}`).join("\n")}`
      : "";

  const labelsContext =
    teamLabels.nodes.length > 0
      ? `All Labels:\n${teamLabels.nodes
          .map((label) => ` - ${label.name} (${label.color})`)
          .join("\n")}`
      : "";

  const issueStateContext =
    state_values.length > 0
      ? `All Issue States:\n${state_values
          .map((state) => ` - ${state.name}`)
          .join("\n")}`
      : "";

  const workspaceContext = [teamsContext, labelsContext, issueStateContext]
    .filter(Boolean)
    .join("\n\n");

  const response = await ask({
    model: "gpt-4o-mini",
    prompt: `You are a Linear project manager.

Your job is to understand the user's request and manage issues, teams, and projects using the available tools.

----
${memory_manager_guide("linear_manager", context_message.author.id)}
----

${
  workspaceContext
    ? `Here is some more context on current linear workspace:\n${workspaceContext}`
    : ""
}

The user you are currently assisting has the following details:
- Name: ${userConfig?.name}
- Linear Email: ${linearEmail}

When responding make sure to link the issues when returning the value.
linear issue links look like: \`https://linear.app/xcelerator/issue/XCE-205\`
Where \`XCE-205\` is the issue ID and \`xcelerator\` is the team name.

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
