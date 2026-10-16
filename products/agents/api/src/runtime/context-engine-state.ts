/**
 * Persistence seam for ContextEngine lifecycle snapshots.
 *
 * The engine owns lifecycle transitions. An adapter only stores and reloads
 * their serializable state. `create` must be atomic for a turn id so two
 * workers cannot start the same turn at the same time.
 */
export interface ContextEngineStateAdapter<TState extends { readonly turnId: string }> {
  create(state: TState): Promise<"created" | "exists">;
  load(turnId: string): Promise<TState | undefined>;
  save(state: TState): Promise<void>;
  remove(turnId: string): Promise<void>;
}

/**
 * Fast adapter used by unit tests and local callers that do not need a
 * database. Cloning on both sides keeps it honest about the durable seam:
 * the engine cannot rely on object identity or process-local mutations.
 */
export class InMemoryContextEngineStateAdapter<TState extends { readonly turnId: string }>
  implements ContextEngineStateAdapter<TState>
{
  private readonly states = new Map<string, TState>();

  public async create(state: TState): Promise<"created" | "exists"> {
    if (this.states.has(state.turnId)) return "exists";
    this.states.set(state.turnId, cloneState(state));
    return "created";
  }

  public async load(turnId: string): Promise<TState | undefined> {
    const state = this.states.get(turnId);
    return state ? cloneState(state) : undefined;
  }

  public async save(state: TState): Promise<void> {
    if (!this.states.has(state.turnId)) {
      throw new Error(`Context turn ${state.turnId} does not exist.`);
    }
    this.states.set(state.turnId, cloneState(state));
  }

  public async remove(turnId: string): Promise<void> {
    this.states.delete(turnId);
  }
}

function cloneState<TState>(state: TState): TState {
  return structuredClone(state);
}
