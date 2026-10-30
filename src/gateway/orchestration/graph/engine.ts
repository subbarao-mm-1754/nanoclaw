/**
 * Minimal state-graph engine for orchestrator runs.
 *
 * Reducer-merged state, nodes with one outgoing route each, interrupt()/resume,
 * and a checkpoint per thread (one thread per orchestration run id).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const START = '__start__';
export const END = '__end__';

/** Max node executions per invoke; a resume re-runs the interrupted node and gets two extra. */
const DEFAULT_RECURSION_LIMIT = 25;
const RESUME_EXTRA_STEPS = 2;

export interface StateChannel<T> {
  reducer: (current: T, update: T) => T;
  default: () => T;
}

export type StateChannels<S> = { [K in keyof S]: StateChannel<S[K]> };

export type NodeFn<S> = (state: S) => Partial<S> | Promise<Partial<S>>;
export type RouterFn<S> = (state: S) => string;

export interface InterruptRecord {
  value: unknown;
}

export interface Checkpoint<S = unknown> {
  values: S;
  /** Node to run next; null once the run reached END. */
  next: string | null;
  interrupt: InterruptRecord | null;
}

export interface Checkpointer {
  get(threadId: string): Checkpoint | null;
  put(threadId: string, checkpoint: Checkpoint): void;
}

export interface InvokeConfig {
  configurable: { thread_id: string };
}

export type InvokeResult<S> = S & { __interrupt__?: InterruptRecord[] };

export class Command<R = unknown> {
  readonly resume: R;
  constructor(input: { resume: R }) {
    this.resume = input.resume;
  }
}

export class GraphRecursionError extends Error {
  constructor(limit: number) {
    super(`Recursion limit of ${limit} reached without hitting a stop condition.`);
    this.name = 'GraphRecursionError';
  }
}

export class MissingCheckpointError extends Error {
  constructor(threadId: string) {
    super(`No checkpoint to resume for thread "${threadId}"`);
    this.name = 'MissingCheckpointError';
  }
}

export class UnknownPendingNodeError extends Error {
  constructor(threadId: string, node: string) {
    super(`Checkpoint for thread "${threadId}" is waiting on node "${node}", which is not in the graph`);
    this.name = 'UnknownPendingNodeError';
  }
}

class GraphInterrupt extends Error {
  constructor(readonly value: unknown) {
    super('Graph interrupted');
    this.name = 'GraphInterrupt';
  }
}

interface ResumeSlot {
  pending: boolean;
  value: unknown;
}

const nodeScope = new AsyncLocalStorage<ResumeSlot>();

/**
 * Pause the current node. The first call after `invoke(new Command({ resume }))`
 * returns the resume value instead of pausing.
 */
export function interrupt<R = unknown>(value: unknown): R {
  const slot = nodeScope.getStore();
  if (!slot) throw new Error('interrupt() must be called inside a graph node');
  if (slot.pending) {
    slot.pending = false;
    return slot.value as R;
  }
  throw new GraphInterrupt(value);
}

export function isInterrupted(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const records = (result as { __interrupt__?: unknown }).__interrupt__;
  return Array.isArray(records) && records.length > 0;
}

/** In-process checkpointer (tests and callers that do not need durability). */
export class MemoryCheckpointer implements Checkpointer {
  private readonly threads = new Map<string, Checkpoint>();

  get(threadId: string): Checkpoint | null {
    const saved = this.threads.get(threadId);
    return saved ? structuredClone(saved) : null;
  }

  put(threadId: string, checkpoint: Checkpoint): void {
    this.threads.set(threadId, structuredClone(checkpoint));
  }
}

export class GraphBuilder<S extends object> {
  private readonly nodes = new Map<string, NodeFn<S>>();
  private readonly edges = new Map<string, string>();
  private readonly routers = new Map<string, RouterFn<S>>();

  constructor(private readonly channels: StateChannels<S>) {}

  addNode(id: string, fn: NodeFn<S>): this {
    if (id === START || id === END) throw new Error(`Node \`${id}\` is reserved.`);
    if (this.nodes.has(id)) throw new Error(`Node \`${id}\` already present.`);
    this.nodes.set(id, fn);
    return this;
  }

  addEdge(from: string, to: string): this {
    this.assertSingleRoute(from);
    this.edges.set(from, to);
    return this;
  }

  addConditionalEdges(from: string, router: RouterFn<S>): this {
    this.assertSingleRoute(from);
    this.routers.set(from, router);
    return this;
  }

  compile(options: { checkpointer: Checkpointer; recursionLimit?: number }): CompiledGraph<S> {
    const entry = this.edges.get(START);
    if (entry === undefined) throw new Error('Graph must have an edge from START.');
    for (const [from, to] of this.edges) {
      if (from !== START && !this.nodes.has(from)) throw new Error(`Edge source \`${from}\` is not a node.`);
      if (to !== END && !this.nodes.has(to)) throw new Error(`Edge target \`${to}\` is not a node.`);
    }
    for (const from of this.routers.keys()) {
      if (from !== START && !this.nodes.has(from)) throw new Error(`Edge source \`${from}\` is not a node.`);
    }
    return new CompiledGraph<S>({
      channels: this.channels,
      nodes: new Map(this.nodes),
      edges: new Map(this.edges),
      routers: new Map(this.routers),
      checkpointer: options.checkpointer,
      recursionLimit: options.recursionLimit ?? DEFAULT_RECURSION_LIMIT,
    });
  }

  private assertSingleRoute(from: string): void {
    if (this.edges.has(from) || this.routers.has(from)) {
      throw new Error(`Node \`${from}\` already has an outgoing edge.`);
    }
  }
}

export class CompiledGraph<S extends object> {
  private readonly channels: StateChannels<S>;
  private readonly nodes: Map<string, NodeFn<S>>;
  private readonly edges: Map<string, string>;
  private readonly routers: Map<string, RouterFn<S>>;
  private readonly checkpointer: Checkpointer;
  private readonly recursionLimit: number;

  constructor(input: {
    channels: StateChannels<S>;
    nodes: Map<string, NodeFn<S>>;
    edges: Map<string, string>;
    routers: Map<string, RouterFn<S>>;
    checkpointer: Checkpointer;
    recursionLimit: number;
  }) {
    this.channels = input.channels;
    this.nodes = input.nodes;
    this.edges = input.edges;
    this.routers = input.routers;
    this.checkpointer = input.checkpointer;
    this.recursionLimit = input.recursionLimit;
  }

  /**
   * Plain input merges into the thread's state and starts from START.
   * A Command resumes the pending node with `resume` as its interrupt() result.
   */
  async invoke(input: Partial<S> | Command, config: InvokeConfig): Promise<InvokeResult<S>> {
    const threadId = config.configurable.thread_id;
    const saved = this.checkpointer.get(threadId) as Checkpoint<S> | null;
    const slot: ResumeSlot = { pending: false, value: undefined };

    let values: S;
    let next: string | null;
    let budget = this.recursionLimit;

    if (input instanceof Command) {
      if (!saved) throw new MissingCheckpointError(threadId);
      values = saved.values;
      next = saved.next;
      if (next === null || next === END) return values;
      if (!this.nodes.has(next)) throw new UnknownPendingNodeError(threadId, next);
      slot.pending = true;
      slot.value = input.resume;
      budget += RESUME_EXTRA_STEPS;
    } else {
      values = this.applyUpdate(saved?.values ?? this.defaults(), input);
      next = this.route(START, values);
      this.save(threadId, values, next, null);
    }

    let steps = 0;
    while (next !== null && next !== END) {
      const fn = this.nodes.get(next);
      if (!fn) {
        next = null;
        break;
      }
      if (steps >= budget) throw new GraphRecursionError(this.recursionLimit);
      steps++;

      let updated: S;
      let after: string;
      try {
        const update = await nodeScope.run(slot, () => fn(values));
        updated = this.applyUpdate(values, update);
        after = this.route(next, updated);
      } catch (err) {
        if (err instanceof GraphInterrupt) {
          const record: InterruptRecord = { value: err.value };
          this.save(threadId, values, next, record);
          return { ...values, __interrupt__: [record] };
        }
        this.save(threadId, values, next, null);
        throw err;
      }

      slot.pending = false;
      values = updated;
      next = after;
      this.save(threadId, values, next === END ? null : next, null);
    }

    this.save(threadId, values, null, null);
    return values;
  }

  private defaults(): S {
    const out = {} as S;
    for (const key of Object.keys(this.channels) as Array<keyof S>) {
      out[key] = this.channels[key].default();
    }
    return out;
  }

  private applyUpdate(values: S, update: unknown): S {
    if (!update || typeof update !== 'object') return values;
    const out = { ...values };
    for (const key of Object.keys(update)) {
      if (!Object.prototype.hasOwnProperty.call(this.channels, key)) continue;
      const k = key as keyof S;
      out[k] = this.channels[k].reducer(out[k], (update as S)[k]);
    }
    return out;
  }

  private route(from: string, values: S): string {
    const router = this.routers.get(from);
    if (router) return router(values);
    return this.edges.get(from) ?? END;
  }

  private save(threadId: string, values: S, next: string | null, record: InterruptRecord | null): void {
    this.checkpointer.put(threadId, { values, next, interrupt: record });
  }
}
