/**
 * Directed graph with BFS/DFS, topological sort and cycle detection
 * (report 21 "Graph: API capability relationships / dependency maps").
 *
 * APIHub uses it for the API Dependency Graph feature: a user models
 * "Travel App -> Flights -> Amadeus -> OAuth2" and the platform renders the
 * integration graph, detects circular dependencies and computes a safe
 * setup order (which credentials must be obtained before which calls).
 */

export interface Edge {
  from: string;
  to: string;
  /** Optional label rendered on the edge, e.g. "requires", "fallback". */
  label?: string;
  weight?: number;
}

export class DirectedGraph<T = unknown> {
  private readonly nodes = new Map<string, T | undefined>();
  private readonly outgoing = new Map<string, Map<string, Edge>>();
  private readonly incoming = new Map<string, Set<string>>();

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    let total = 0;
    for (const edges of this.outgoing.values()) total += edges.size;
    return total;
  }

  addNode(id: string, data?: T): void {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, data);
      this.outgoing.set(id, new Map());
      this.incoming.set(id, new Set());
    } else if (data !== undefined) {
      this.nodes.set(id, data);
    }
  }

  getNode(id: string): T | undefined {
    return this.nodes.get(id);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  /** Add a directed edge, creating either endpoint if it does not exist. */
  addEdge(edge: Edge): void {
    this.addNode(edge.from);
    this.addNode(edge.to);
    this.outgoing.get(edge.from)?.set(edge.to, edge);
    this.incoming.get(edge.to)?.add(edge.from);
  }

  removeEdge(from: string, to: string): boolean {
    const removed = this.outgoing.get(from)?.delete(to) ?? false;
    if (removed) this.incoming.get(to)?.delete(from);
    return removed;
  }

  neighbors(id: string): string[] {
    return [...(this.outgoing.get(id)?.keys() ?? [])];
  }

  predecessors(id: string): string[] {
    return [...(this.incoming.get(id) ?? [])];
  }

  edges(): Edge[] {
    const out: Edge[] = [];
    for (const map of this.outgoing.values()) out.push(...map.values());
    return out;
  }

  nodeIds(): string[] {
    return [...this.nodes.keys()];
  }

  /** In-degree, i.e. how many nodes depend on this one. */
  inDegree(id: string): number {
    return this.incoming.get(id)?.size ?? 0;
  }

  outDegree(id: string): number {
    return this.outgoing.get(id)?.size ?? 0;
  }

  /**
   * Breadth-first traversal from `start`. Returns nodes in visit order along
   * with their distance from the start. O(V + E).
   */
  bfs(start: string, maxDepth = Infinity): { id: string; depth: number }[] {
    if (!this.nodes.has(start)) return [];

    const visited = new Set<string>([start]);
    const order: { id: string; depth: number }[] = [];

    // Index-based queue head avoids the O(n) cost of Array.prototype.shift().
    const queue: { id: string; depth: number }[] = [{ id: start, depth: 0 }];
    let head = 0;

    while (head < queue.length) {
      const current = queue[head] as { id: string; depth: number };
      head += 1;
      order.push(current);

      if (current.depth >= maxDepth) continue;

      for (const next of this.neighbors(current.id)) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push({ id: next, depth: current.depth + 1 });
      }
    }
    return order;
  }

  /** Iterative depth-first traversal. Iterative to survive deep graphs. */
  dfs(start: string): string[] {
    if (!this.nodes.has(start)) return [];

    const visited = new Set<string>();
    const order: string[] = [];
    const stack: string[] = [start];

    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (visited.has(id)) continue;
      visited.add(id);
      order.push(id);

      // Reverse so that neighbours are explored in insertion order.
      const next = this.neighbors(id);
      for (let i = next.length - 1; i >= 0; i -= 1) stack.push(next[i] as string);
    }
    return order;
  }

  /** Shortest unweighted path via BFS, or null when unreachable. */
  shortestPath(from: string, to: string): string[] | null {
    if (!this.nodes.has(from) || !this.nodes.has(to)) return null;
    if (from === to) return [from];

    const previous = new Map<string, string>();
    const visited = new Set<string>([from]);
    const queue: string[] = [from];
    let head = 0;

    while (head < queue.length) {
      const current = queue[head] as string;
      head += 1;

      for (const next of this.neighbors(current)) {
        if (visited.has(next)) continue;
        visited.add(next);
        previous.set(next, current);

        if (next === to) {
          const path = [to];
          let cursor = to;
          while (previous.has(cursor)) {
            cursor = previous.get(cursor) as string;
            path.push(cursor);
          }
          return path.reverse();
        }
        queue.push(next);
      }
    }
    return null;
  }

  /**
   * Kahn's algorithm. Returns a dependency-safe ordering, or null when the
   * graph contains a cycle. O(V + E).
   */
  topologicalSort(): string[] | null {
    const degree = new Map<string, number>();
    for (const id of this.nodes.keys()) degree.set(id, this.inDegree(id));

    const queue: string[] = [];
    for (const [id, count] of degree) {
      if (count === 0) queue.push(id);
    }

    const order: string[] = [];
    let head = 0;

    while (head < queue.length) {
      const id = queue[head] as string;
      head += 1;
      order.push(id);

      for (const next of this.neighbors(id)) {
        const remaining = (degree.get(next) ?? 0) - 1;
        degree.set(next, remaining);
        if (remaining === 0) queue.push(next);
      }
    }

    return order.length === this.nodes.size ? order : null;
  }

  hasCycle(): boolean {
    return this.topologicalSort() === null;
  }

  /**
   * Find one cycle, for a useful error message rather than a bare boolean.
   * Uses DFS colouring: white (unvisited), grey (on stack), black (done).
   * A grey -> grey edge is a back edge and closes a cycle.
   */
  findCycle(): string[] | null {
    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;

    const colour = new Map<string, number>();
    for (const id of this.nodes.keys()) colour.set(id, WHITE);

    const parent = new Map<string, string>();

    const walk = (start: string): string[] | null => {
      const stack: { id: string; iterator: Iterator<string> }[] = [];
      colour.set(start, GREY);
      stack.push({ id: start, iterator: this.neighbors(start)[Symbol.iterator]() });

      while (stack.length > 0) {
        const frame = stack[stack.length - 1] as { id: string; iterator: Iterator<string> };
        const step = frame.iterator.next();

        if (step.done) {
          colour.set(frame.id, BLACK);
          stack.pop();
          continue;
        }

        const next = step.value;
        const nextColour = colour.get(next) ?? WHITE;

        if (nextColour === GREY) {
          // Reconstruct the cycle by walking parents back to `next`.
          const cycle = [next];
          let cursor = frame.id;
          while (cursor !== next && parent.has(cursor)) {
            cycle.push(cursor);
            cursor = parent.get(cursor) as string;
          }
          cycle.push(next);
          return cycle.reverse();
        }

        if (nextColour === WHITE) {
          colour.set(next, GREY);
          parent.set(next, frame.id);
          stack.push({ id: next, iterator: this.neighbors(next)[Symbol.iterator]() });
        }
      }
      return null;
    };

    for (const id of this.nodes.keys()) {
      if (colour.get(id) === WHITE) {
        const cycle = walk(id);
        if (cycle) return cycle;
      }
    }
    return null;
  }

  /**
   * Weakly connected components: treat every edge as undirected and group
   * nodes that are reachable from one another. Used to split a user's
   * dependency map into independent integration clusters.
   */
  connectedComponents(): string[][] {
    const visited = new Set<string>();
    const components: string[][] = [];

    for (const start of this.nodes.keys()) {
      if (visited.has(start)) continue;

      const component: string[] = [];
      const stack = [start];
      visited.add(start);

      while (stack.length > 0) {
        const id = stack.pop() as string;
        component.push(id);

        for (const next of [...this.neighbors(id), ...this.predecessors(id)]) {
          if (visited.has(next)) continue;
          visited.add(next);
          stack.push(next);
        }
      }
      components.push(component);
    }
    return components;
  }
}
