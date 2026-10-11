import type { LocalRuntimeAdapter } from "./adapter.ts";
import type { LocalRuntimeId } from "./types.ts";

export class LocalRuntimeRegistry {
  readonly #adapters = new Map<LocalRuntimeId, LocalRuntimeAdapter>();

  register(adapter: LocalRuntimeAdapter): void {
    this.#adapters.set(adapter.id, adapter);
  }

  get(id: LocalRuntimeId): LocalRuntimeAdapter | undefined {
    return this.#adapters.get(id);
  }

  list(): LocalRuntimeAdapter[] {
    return [...this.#adapters.values()];
  }
}
