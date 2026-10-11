/**
 * Uptokey TUI — MCP (Model Context Protocol) tool integration.
 * Discovers, binds, and invokes MCP tools via the proxy.
 */
import type { TuiClient } from "./client.ts";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverId: string;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; data?: string }>;
  isError?: boolean;
}

export interface McpSkill {
  id: string;
  name: string;
  description: string;
  installed: boolean;
}

export class McpService {
  private client: TuiClient;

  constructor(client: TuiClient) {
    this.client = client;
  }

  /** List available MCP tools from all connected servers. */
  async listTools(): Promise<McpTool[]> {
    try {
      const res = await this.client.fetchAuth("/v1/workspace/capabilities");
      if (!res.ok) return [];
      const data = await res.json() as { capabilities?: Array<{ id: string; availability: string; tools?: McpTool[] }> };
      const tools: McpTool[] = [];
      for (const cap of data.capabilities ?? []) {
        if (cap.tools) tools.push(...cap.tools);
      }
      return tools;
    } catch {
      return [];
    }
  }

  /** List available skills. */
  async listSkills(): Promise<McpSkill[]> {
    try {
      const res = await this.client.fetchAuth("/v1/workspace/project-agent/capabilities");
      if (!res.ok) return [];
      const data = await res.json() as { skills?: McpSkill[] };
      return data.skills ?? [];
    } catch {
      return [];
    }
  }

  /** Preview a skill before installing. */
  async previewSkill(skillId: string): Promise<{ name: string; description: string; tools: string[] } | null> {
    try {
      const res = await this.client.fetchAuth(`/v1/workspace/project-agent/preview/start`, {
        method: "POST",
        body: JSON.stringify({ skillId }),
      });
      if (!res.ok) return null;
      return await res.json() as { name: string; description: string; tools: string[] };
    } catch {
      return null;
    }
  }
}
