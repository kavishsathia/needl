import type { NeedlRepository, StoredIntegration } from "./repository.js";
import { SecretBox } from "./secrets.js";

/** A flow enabled in the chosen GitLab project, as offered during setup. */
export interface FlowOption {
  readonly consumerId: number;
  readonly name: string;
  readonly foundational: boolean;
}

export interface FlowDiscovery {
  readonly gitlabUser: string;
  readonly project: { readonly id: string; readonly path: string };
  readonly flows: readonly FlowOption[];
}

/** What the Connections page shows; never includes the token. */
export interface FlowConnectionSummary {
  readonly connected: boolean;
  readonly gitlabUser?: string;
  readonly projectPath?: string;
  readonly flowName?: string;
  readonly consumerId?: number;
  readonly goal: string;
  readonly autoLaunch: boolean;
  readonly updatedAt?: string;
}

export const defaultFlowGoal = "Open a draft merge request that fixes the cause of this violation. Explain what you changed and why in the merge request description. Do not merge or deploy.";

const gitlabUrl = "https://gitlab.com";

function fail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Sets up the GitLab flow a workspace launches on violations: token, project, flow, instructions. */
export class FlowConnectionService {
  #box: SecretBox | undefined;

  constructor(
    private readonly repository: NeedlRepository,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private box(): SecretBox {
    return this.#box ??= SecretBox.fromEnvironment(this.environment);
  }

  private async gitlab(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${gitlabUrl}${path}`, {
        ...init, signal: AbortSignal.timeout(10_000),
        headers: { "private-token": token, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
      });
    } catch {
      fail("GitLab could not be reached. Try again in a moment.", 502);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (response.status === 401) fail("GitLab rejected this token. Check that it is pasted in full and has not expired.");
    if (response.status === 403) fail("This token is not allowed to do that. It needs the api scope.");
    if (response.status === 404) fail("GitLab could not find that project with this token. Check the path and that you are a member.");
    if (!response.ok) fail(`GitLab returned an error (${response.status}).`, 502);
    return body;
  }

  /** Checks a token and project, and lists the flows enabled there. */
  async discover(token: string, project: string): Promise<FlowDiscovery> {
    const trimmed = token.trim();
    if (trimmed.length < 20 || /\s/.test(trimmed)) fail("Paste the full GitLab access token");
    const projectRef = project.trim().replace(/^https?:\/\/gitlab\.com\//, "").replace(/\/+$/, "");
    if (projectRef.length === 0) fail("Enter the GitLab project, for example group/project");

    const user = object(await this.gitlab(trimmed, "/api/v4/user"));
    // GitLab ignores flow triggers from bots and service accounts, so launches must act as a person.
    if (user?.bot === true) fail("This token belongs to a bot or service account. GitLab only starts flows for people, so use a personal access token.");
    const self = object(await this.gitlab(trimmed, "/api/v4/personal_access_tokens/self").catch(() => undefined));
    const scopes = Array.isArray(self?.scopes) ? self.scopes : undefined;
    if (scopes !== undefined && !scopes.includes("api")) fail("This token needs the api scope to start flows.");

    const found = object(await this.gitlab(trimmed, `/api/v4/projects/${encodeURIComponent(projectRef)}`));
    const id = typeof found?.id === "number" ? String(found.id) : fail("GitLab returned a project without an id", 502);
    const path = typeof found?.path_with_namespace === "string" ? found.path_with_namespace : projectRef;

    const graph = object(await this.gitlab(trimmed, "/api/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: "query NeedlFlows($projectId: ProjectID!) { aiCatalogConfiguredItems(projectId: $projectId, itemTypes: [FLOW], first: 50) { nodes { id enabled item { name foundational } } } }",
        variables: { projectId: `gid://gitlab/Project/${id}` },
      }),
    }));
    const nodes = object(object(graph?.data)?.aiCatalogConfiguredItems)?.nodes;
    const flows = (Array.isArray(nodes) ? nodes : []).flatMap((raw): FlowOption[] => {
      const node = object(raw);
      const item = object(node?.item);
      const consumerId = Number(String(node?.id ?? "").split("/").pop());
      if (node?.enabled !== true || !Number.isSafeInteger(consumerId) || typeof item?.name !== "string") return [];
      return [{ consumerId, name: item.name, foundational: item.foundational === true }];
    });
    return { gitlabUser: typeof user?.username === "string" ? user.username : "unknown", project: { id, path }, flows };
  }

  /** Discovery with a newly pasted token, or with the workspace's saved one when editing. */
  async discoverFor(tenantId: string, token: string | undefined, project: string): Promise<FlowDiscovery> {
    if (token !== undefined && token.trim().length > 0) return this.discover(token, project);
    const existing = await this.repository.findFlowConnection(tenantId);
    if (existing?.secretCiphertext === undefined) fail("Paste a GitLab access token");
    return this.discover(this.box().open(existing.secretCiphertext), project);
  }

  async summary(tenantId: string): Promise<FlowConnectionSummary> {
    const integration = await this.repository.findFlowConnection(tenantId);
    if (integration === undefined) return { connected: false, goal: defaultFlowGoal, autoLaunch: false };
    return summarize(integration);
  }

  async save(tenantId: string, input: { readonly token?: string; readonly project: string; readonly consumerId: number; readonly goal?: string; readonly autoLaunch: boolean }): Promise<FlowConnectionSummary> {
    const existing = await this.repository.findFlowConnection(tenantId);
    const newToken = input.token !== undefined && input.token.trim().length > 0 ? input.token.trim() : undefined;
    const token = newToken ?? (existing?.secretCiphertext === undefined ? undefined : this.box().open(existing.secretCiphertext));
    if (token === undefined) fail("Paste a GitLab access token");
    const discovery = await this.discover(token, input.project);
    const flow = discovery.flows.find((item) => item.consumerId === input.consumerId)
      ?? fail("That flow is not enabled in this project. Pick one from the list.");
    const goal = (input.goal ?? "").trim().slice(0, 4_000) || defaultFlowGoal;
    const wasAuto = existing?.enabled === true && existing.config.autoLaunch === true;
    const config = {
      baseUrl: gitlabUrl,
      projectId: discovery.project.id,
      projectPath: discovery.project.path,
      consumerId: flow.consumerId,
      flowName: flow.name,
      tokenType: "private-token",
      gitlabUser: discovery.gitlabUser,
      goal,
      autoLaunch: input.autoLaunch,
      // Only violations found after automatic launch is switched on start flows, never a backlog.
      ...(input.autoLaunch ? { autoLaunchSince: wasAuto && typeof existing.config.autoLaunchSince === "string" ? existing.config.autoLaunchSince : new Date().toISOString() } : {}),
    };
    const saved = await this.repository.saveFlowConnection(tenantId, config, newToken === undefined ? undefined : this.box().seal(newToken));
    return summarize(saved);
  }

  async remove(tenantId: string): Promise<boolean> {
    return this.repository.disableFlowConnection(tenantId);
  }
}

function summarize(integration: StoredIntegration): FlowConnectionSummary {
  const config = integration.config;
  return {
    connected: integration.enabled && integration.secretCiphertext !== undefined,
    ...(typeof config.gitlabUser === "string" ? { gitlabUser: config.gitlabUser } : {}),
    ...(typeof config.projectPath === "string" ? { projectPath: config.projectPath } : {}),
    ...(typeof config.flowName === "string" ? { flowName: config.flowName } : {}),
    ...(typeof config.consumerId === "number" ? { consumerId: config.consumerId } : {}),
    goal: typeof config.goal === "string" ? config.goal : defaultFlowGoal,
    autoLaunch: integration.enabled && config.autoLaunch === true,
    updatedAt: integration.updatedAt,
  };
}
