import {
  type CapabilityDescriptor,
  type WorkflowScope,
  parseCapabilityDescriptor,
  parseExecutionPlan,
  WorkflowContractError,
} from "@uptokey/sync-contract/workflow";
import {
  CROSSREF_CAPABILITY_ID,
  CROSSREF_CAPABILITY_VERSION,
} from "./adapters/crossref-adapter.ts";
import {
  OPEN_LIBRARY_CAPABILITY_ID,
  OPEN_LIBRARY_CAPABILITY_VERSION,
} from "./adapters/open-library-adapter.ts";

/**
 * Built-in capability registry aligned with W0 shared contract.
 * Separates executable capabilities from editorial catalog items.
 */

export const CROSSREF_CAPABILITY: CapabilityDescriptor = parseCapabilityDescriptor({
  schemaVersion: 1,
  id: CROSSREF_CAPABILITY_ID,
  createdAt: "2026-09-16T12:00:00.000Z",
  version: CROSSREF_CAPABILITY_VERSION,
  titleKey: "workflow.sources.crossref.search.title",
  descriptionKey: "workflow.sources.crossref.search.description",
  tags: ["research", "academic", "doi", "bibliography"],
  inputSchemaId: "sources.crossref.search.input.v1",
  outputSchemaId: "sources.crossref.search.output.v1",
  effect: "read_external",
  dataDestination: {
    kind: "public_source",
    id: "crossref",
  },
  availability: "executable",
  supportLevel: "experimental",
  requiredScopes: ["run:execute"],
  retryClass: "read_only",
  limits: {
    maxSteps: 12,
    maxCalls: 12,
    maxOutputTokens: 4096,
    timeoutMs: 12_000,
    maxOutputBytes: 512_000,
  },
});

export const OPEN_LIBRARY_CAPABILITY: CapabilityDescriptor = parseCapabilityDescriptor({
  schemaVersion: 1,
  id: OPEN_LIBRARY_CAPABILITY_ID,
  createdAt: "2026-09-16T12:00:00.000Z",
  version: OPEN_LIBRARY_CAPABILITY_VERSION,
  titleKey: "workflow.sources.open-library.search.title",
  descriptionKey: "workflow.sources.open-library.search.description",
  tags: ["research", "books", "authors", "literature"],
  inputSchemaId: "sources.open-library.search.input.v1",
  outputSchemaId: "sources.open-library.search.output.v1",
  effect: "read_external",
  dataDestination: {
    kind: "public_source",
    id: "open-library",
  },
  availability: "executable",
  supportLevel: "experimental",
  requiredScopes: ["run:execute"],
  retryClass: "read_only",
  limits: {
    maxSteps: 12,
    maxCalls: 12,
    maxOutputTokens: 4096,
    timeoutMs: 12_000,
    maxOutputBytes: 512_000,
  },
});

export const PUBMED_CAPABILITY: CapabilityDescriptor = parseCapabilityDescriptor({
  schemaVersion: 1,
  id: "sources.pubmed.search",
  createdAt: "2026-09-16T12:00:00.000Z",
  version: 1,
  titleKey: "workflow.sources.pubmed.search.title",
  descriptionKey: "workflow.sources.pubmed.search.description",
  tags: ["research", "biomedical", "medical", "pubmed"],
  inputSchemaId: "sources.pubmed.search.input.v1",
  outputSchemaId: "sources.pubmed.search.output.v1",
  effect: "read_external",
  dataDestination: {
    kind: "public_source",
    id: "pubmed",
  },
  availability: "executable",
  supportLevel: "experimental",
  requiredScopes: ["run:execute"],
  retryClass: "read_only",
  limits: {
    maxSteps: 12,
    maxCalls: 12,
    maxOutputTokens: 4096,
    timeoutMs: 12_000,
    maxOutputBytes: 512_000,
  },
});

export const OPENALEX_CAPABILITY: CapabilityDescriptor = parseCapabilityDescriptor({
  schemaVersion: 1,
  id: "sources.openalex.search",
  createdAt: "2026-09-30T12:00:00.000Z",
  version: 1,
  titleKey: "workflow.sources.openalex.search.title",
  descriptionKey: "workflow.sources.openalex.search.description",
  tags: ["research", "academic", "openalex", "bibliography"],
  inputSchemaId: "sources.openalex.search.input.v1",
  outputSchemaId: "sources.openalex.search.output.v1",
  effect: "read_external",
  dataDestination: {
    kind: "public_source",
    id: "openalex",
  },
  availability: "executable",
  supportLevel: "experimental",
  requiredScopes: ["run:execute"],
  retryClass: "read_only",
  limits: {
    maxSteps: 12,
    maxCalls: 12,
    maxOutputTokens: 4096,
    timeoutMs: 12_000,
    maxOutputBytes: 512_000,
  },
});

export const ARCHIVE_UNAVAILABLE_CAPABILITY: CapabilityDescriptor = parseCapabilityDescriptor({
  schemaVersion: 1,
  id: "sources.archive.search",
  createdAt: "2026-09-16T12:00:00.000Z",
  version: 1,
  titleKey: "workflow.sources.archive.search.title",
  descriptionKey: "workflow.sources.archive.search.description",
  tags: ["research", "historical", "archive"],
  inputSchemaId: "sources.archive.search.input.v1",
  outputSchemaId: "sources.archive.search.output.v1",
  effect: "read_external",
  dataDestination: {
    kind: "public_source",
    id: "archive",
  },
  availability: "unavailable",
  supportLevel: "catalogued",
  requiredScopes: ["run:execute"],
  retryClass: "read_only",
  limits: {
    maxSteps: 12,
    maxCalls: 12,
    maxOutputTokens: 4096,
    timeoutMs: 12_000,
    maxOutputBytes: 512_000,
  },
});


export const RSS_CAPABILITY: CapabilityDescriptor = parseCapabilityDescriptor({
  schemaVersion: 1,
  id: "api.rss.read",
  createdAt: "2026-09-16T12:00:00.000Z",
  version: 1,
  titleKey: "workflow.sources.rss.read.title",
  descriptionKey: "workflow.sources.rss.read.description",
  tags: ["rss", "feed", "news"],
  inputSchemaId: "api.rss.read.input.v1",
  outputSchemaId: "api.rss.read.output.v1",
  effect: "read_external",
  dataDestination: {
    kind: "public_source",
    id: "rss",
  },
  availability: "executable",
  supportLevel: "experimental",
  requiredScopes: ["run:execute"],
  retryClass: "read_only",
  limits: {
    maxSteps: 12,
    maxCalls: 12,
    maxOutputTokens: 4096,
    timeoutMs: 12_000,
    maxOutputBytes: 512_000,
  },
});

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityDescriptor>();

  constructor(
    initial: readonly CapabilityDescriptor[] = [
      CROSSREF_CAPABILITY,
      OPEN_LIBRARY_CAPABILITY,
      PUBMED_CAPABILITY,
      OPENALEX_CAPABILITY,
      ARCHIVE_UNAVAILABLE_CAPABILITY,
    ]
  ) {
    for (const cap of initial) {
      this.register(cap);
    }
  }

  register(cap: CapabilityDescriptor): void {
    const validated = parseCapabilityDescriptor(cap);
    const key = `${validated.id}@${validated.version}`;
    this.capabilities.set(key, validated);
  }

  get(id: string, version: number): CapabilityDescriptor | undefined {
    return this.capabilities.get(`${id}@${version}`);
  }

  list(): readonly CapabilityDescriptor[] {
    return Array.from(this.capabilities.values());
  }

  /** Resolve only descriptors referenced by a bounded plan; catalogue size is not execution authority. */
  forPlan(plan: unknown, additional: readonly CapabilityDescriptor[] = []): readonly CapabilityDescriptor[] {
    const parsed = parseExecutionPlan(plan);
    const required = new Set(parsed.steps.map(step => `${step.capabilityId}@${step.capabilityVersion}`));
    const candidates = [...this.capabilities.values(), ...additional.map(parseCapabilityDescriptor)];
    const selected = candidates.filter(capability => required.has(`${capability.id}@${capability.version}`));
    const found = new Set(selected.map(capability => `${capability.id}@${capability.version}`));
    // Do not silently select one of two conflicting declarations, or omit a missing reference.
    if (selected.length !== found.size || found.size !== required.size) throw new WorkflowContractError();
    return selected;
  }

  listExecutable(grantedScopes: readonly WorkflowScope[] = []): readonly CapabilityDescriptor[] {
    const granted = new Set(grantedScopes);
    return Array.from(this.capabilities.values()).filter((cap) => {
      if (cap.availability !== "executable") return false;
      return cap.requiredScopes.every((scope) => granted.has(scope));
    });
  }

  assertExecutable(
    id: string,
    version: number,
    grantedScopes: readonly WorkflowScope[] = []
  ): CapabilityDescriptor {
    const cap = this.get(id, version);
    if (!cap) {
      throw new Error(`capability_not_found:${id}@${version}`);
    }
    if (cap.availability !== "executable") {
      throw new Error(`capability_not_executable:${cap.availability}`);
    }
    const granted = new Set(grantedScopes);
    const missing = cap.requiredScopes.filter((s) => !granted.has(s));
    if (missing.length > 0) {
      throw new Error(`insufficient_scopes:${missing.join(",")}`);
    }
    return cap;
  }
}

export const PROJECT_WRITE_CAPABILITY_ID = "workspace.project.write";
export const PROJECT_WRITE_CAPABILITY_VERSION = 1;

export const PROJECT_WRITE_CAPABILITY: CapabilityDescriptor = parseCapabilityDescriptor({
  schemaVersion: 1,
  id: PROJECT_WRITE_CAPABILITY_ID,
  createdAt: "2026-09-19T12:00:00.000Z",
  version: PROJECT_WRITE_CAPABILITY_VERSION,
  titleKey: "workflow.capabilities.project_write.title",
  descriptionKey: "workflow.capabilities.project_write.description",
  tags: ["project", "write", "filesystem"],
  inputSchemaId: "workspace.project.write.input.v1",
  outputSchemaId: "workspace.project.write.output.v1",
  effect: "produce_artifact",
  dataDestination: {
    kind: "local",
    id: "authorized_project_root",
  },
  availability: "executable",
  supportLevel: "integrated",
  requiredScopes: ["run:execute"],
  retryClass: "idempotent_local",
  limits: {
    maxSteps: 8,
    maxCalls: 8,
    maxOutputTokens: 4096,
    timeoutMs: 30_000,
    maxOutputBytes: 10_000_000,
  },
});

export { PROJECT_HOST_COMMAND_CAPABILITY } from "./project-host-command.ts";
