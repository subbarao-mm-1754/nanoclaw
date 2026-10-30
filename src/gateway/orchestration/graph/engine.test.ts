import { describe, expect, it } from 'vitest';

import {
  Command,
  END,
  GraphRecursionError,
  MemoryCheckpointer,
  MissingCheckpointError,
  START,
  GraphBuilder,
  UnknownPendingNodeError,
  interrupt,
  isInterrupted,
  type StateChannels,
} from './engine.js';

interface S {
  n: number;
  log: string[];
}

const channels: StateChannels<S> = {
  n: { reducer: (_a, b) => b, default: () => 0 },
  log: { reducer: (a, b) => [...a, ...b], default: () => [] },
};

const cfg = (thread: string) => ({ configurable: { thread_id: thread } });

describe('graph engine', () => {
  it('applies reducers to input and node updates, ignoring unknown keys', async () => {
    const app = new GraphBuilder<S>(channels)
      .addNode('a', (s) => ({ n: s.n + 1, log: ['a'], zzz: 1 }) as Partial<S>)
      .addEdge(START, 'a')
      .addEdge('a', END)
      .compile({ checkpointer: new MemoryCheckpointer() });

    const out = await app.invoke({ n: 4, log: ['in'] }, cfg('t'));
    expect(out).toEqual({ n: 5, log: ['in', 'a'] });
  });

  it('pauses on interrupt and resumes the same node with the resume value', async () => {
    const app = new GraphBuilder<S>(channels)
      .addNode('a', () => ({ log: ['a'] }))
      .addNode('b', () => {
        const v = interrupt<number>({ ask: 'b' });
        return { n: v, log: ['b'] };
      })
      .addEdge(START, 'a')
      .addEdge('a', 'b')
      .addEdge('b', END)
      .compile({ checkpointer: new MemoryCheckpointer() });

    const paused = await app.invoke({}, cfg('t'));
    expect(isInterrupted(paused)).toBe(true);
    expect(paused.__interrupt__?.[0]?.value).toEqual({ ask: 'b' });
    expect(paused.log).toEqual(['a']);

    const done = await app.invoke(new Command({ resume: 9 }), cfg('t'));
    expect(isInterrupted(done)).toBe(false);
    expect(done).toEqual({ n: 9, log: ['a', 'b'] });
  });

  it('gives the resume value only to the resumed node', async () => {
    let skipFirst = false;
    const app = new GraphBuilder<S>(channels)
      .addNode('a', () => {
        if (!skipFirst) interrupt('a');
        return { log: ['a'] };
      })
      .addNode('b', () => {
        const v = interrupt<number>('b');
        return { n: v };
      })
      .addEdge(START, 'a')
      .addEdge('a', 'b')
      .addEdge('b', END)
      .compile({ checkpointer: new MemoryCheckpointer() });

    await app.invoke({}, cfg('t'));
    skipFirst = true;
    const out = await app.invoke(new Command({ resume: 1 }), cfg('t'));
    expect(out.__interrupt__?.[0]?.value).toBe('b');
  });

  it('ends the run when a router returns an unknown node', async () => {
    const app = new GraphBuilder<S>(channels)
      .addNode('a', () => ({ n: 1 }))
      .addEdge(START, 'a')
      .addConditionalEdges('a', () => 'missing')
      .compile({ checkpointer: new MemoryCheckpointer() });

    const out = await app.invoke({}, cfg('t'));
    expect(out).toEqual({ n: 1, log: [] });
  });

  it('merges fresh input into an existing thread and restarts from START', async () => {
    const app = new GraphBuilder<S>(channels)
      .addNode('a', (s) => {
        const v = interrupt<number>({ n: s.n });
        return { n: v, log: ['a'] };
      })
      .addEdge(START, 'a')
      .addEdge('a', END)
      .compile({ checkpointer: new MemoryCheckpointer() });

    await app.invoke({ n: 1, log: ['in1'] }, cfg('t'));
    const second = await app.invoke({ n: 2, log: ['in2'] }, cfg('t'));
    expect(second.log).toEqual(['in1', 'in2']);
    expect(second.__interrupt__?.[0]?.value).toEqual({ n: 2 });
    const done = await app.invoke(new Command({ resume: 9 }), cfg('t'));
    expect(done).toEqual({ n: 9, log: ['in1', 'in2', 'a'] });
  });

  it('throws when resuming a thread with no checkpoint', async () => {
    const app = new GraphBuilder<S>(channels)
      .addNode('a', () => ({ n: interrupt<number>('a') }))
      .addEdge(START, 'a')
      .addEdge('a', END)
      .compile({ checkpointer: new MemoryCheckpointer() });

    await expect(app.invoke(new Command({ resume: 1 }), cfg('none'))).rejects.toBeInstanceOf(
      MissingCheckpointError,
    );
  });

  it('throws when the pending node is no longer in the graph', async () => {
    const checkpointer = new MemoryCheckpointer();
    const first = new GraphBuilder<S>(channels)
      .addNode('a', () => ({ n: interrupt<number>('a') }))
      .addEdge(START, 'a')
      .addEdge('a', END)
      .compile({ checkpointer });
    await first.invoke({}, cfg('t'));

    const second = new GraphBuilder<S>(channels)
      .addNode('b', () => ({ n: 2 }))
      .addEdge(START, 'b')
      .addEdge('b', END)
      .compile({ checkpointer });
    await expect(second.invoke(new Command({ resume: 1 }), cfg('t'))).rejects.toBeInstanceOf(
      UnknownPendingNodeError,
    );
  });

  it('returns stored state when resuming a finished thread', async () => {
    const app = new GraphBuilder<S>(channels)
      .addNode('a', () => ({ n: 1, log: ['a'] }))
      .addEdge(START, 'a')
      .addEdge('a', END)
      .compile({ checkpointer: new MemoryCheckpointer() });

    await app.invoke({}, cfg('t'));
    expect(await app.invoke(new Command({ resume: 3 }), cfg('t'))).toEqual({ n: 1, log: ['a'] });
  });

  it('keeps the failed node pending after a node error', async () => {
    let fail = true;
    const app = new GraphBuilder<S>(channels)
      .addNode('a', () => ({ n: 1, log: ['a'] }))
      .addNode('b', () => {
        if (fail) throw new Error('boom');
        return { log: ['b'] };
      })
      .addEdge(START, 'a')
      .addEdge('a', 'b')
      .addEdge('b', END)
      .compile({ checkpointer: new MemoryCheckpointer() });

    await expect(app.invoke({}, cfg('t'))).rejects.toThrow('boom');
    fail = false;
    expect(await app.invoke(new Command({ resume: 1 }), cfg('t'))).toEqual({ n: 1, log: ['a', 'b'] });
  });

  it('stops runaway loops after 25 node runs, or 27 when resuming', async () => {
    let count = 0;
    let pauseAt = -1;
    const app = new GraphBuilder<S>(channels)
      .addNode('a', (s) => {
        count++;
        if (count === pauseAt) interrupt('p');
        return { n: s.n + 1 };
      })
      .addEdge(START, 'a')
      .addConditionalEdges('a', () => 'a')
      .compile({ checkpointer: new MemoryCheckpointer() });

    await expect(app.invoke({}, cfg('fresh'))).rejects.toBeInstanceOf(GraphRecursionError);
    expect(count).toBe(25);

    count = 0;
    pauseAt = 25;
    const paused = await app.invoke({}, cfg('resume'));
    expect(isInterrupted(paused)).toBe(true);
    count = 0;
    pauseAt = -1;
    await expect(app.invoke(new Command({ resume: 1 }), cfg('resume'))).rejects.toBeInstanceOf(
      GraphRecursionError,
    );
    expect(count).toBe(27);
  });

  it('rejects reserved and duplicate node ids and a missing entry edge', () => {
    expect(() => new GraphBuilder<S>(channels).addNode(START, () => ({}))).toThrow('reserved');
    expect(() => new GraphBuilder<S>(channels).addNode(END, () => ({}))).toThrow('reserved');
    expect(() =>
      new GraphBuilder<S>(channels).addNode('a', () => ({})).addNode('a', () => ({})),
    ).toThrow('already present');
    expect(() =>
      new GraphBuilder<S>(channels).addNode('a', () => ({})).compile({
        checkpointer: new MemoryCheckpointer(),
      }),
    ).toThrow('edge from START');
  });

  it('accepts node ids that match state keys or contain : and |', async () => {
    const app = new GraphBuilder<S>(channels)
      .addNode('n', () => ({ log: ['n'] }))
      .addNode('a:b|c', () => ({ log: ['abc'] }))
      .addEdge(START, 'n')
      .addEdge('n', 'a:b|c')
      .addEdge('a:b|c', END)
      .compile({ checkpointer: new MemoryCheckpointer() });

    expect(await app.invoke({}, cfg('t'))).toEqual({ n: 0, log: ['n', 'abc'] });
  });

  it('isolates threads on one checkpointer', async () => {
    const app = new GraphBuilder<S>(channels)
      .addNode('a', (s) => ({ n: interrupt<number>(s.n) }))
      .addEdge(START, 'a')
      .addEdge('a', END)
      .compile({ checkpointer: new MemoryCheckpointer() });

    await app.invoke({ n: 1 }, cfg('x'));
    await app.invoke({ n: 2 }, cfg('y'));
    expect((await app.invoke(new Command({ resume: 10 }), cfg('x'))).n).toBe(10);
    const y = await app.invoke({}, cfg('y'));
    expect(y.__interrupt__?.[0]?.value).toBe(2);
  });
});
