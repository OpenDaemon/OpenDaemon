/**
 * Process dependency graph helpers, shared by config validation and the process manager.
 */

export interface DependencyNode {
  name: string;
  dependencies?: string[] | undefined;
}

/**
 * Group apps into start levels: level 0 has no dependencies, level n depends only on earlier
 * levels. Apps in one level can start in parallel; stopping walks the levels in reverse.
 *
 * Throws on an unknown dependency or a cycle, naming the apps involved.
 */
export function dependencyLevels(nodes: readonly DependencyNode[]): string[][] {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  for (const node of nodes) {
    for (const dep of node.dependencies ?? []) {
      if (dep === node.name) {
        throw new Error(`App "${node.name}" depends on itself`);
      }
      if (!byName.has(dep)) {
        throw new Error(`App "${node.name}" depends on unknown app "${dep}"`);
      }
    }
  }

  const level = new Map<string, number>();
  const visiting: string[] = [];
  const visit = (name: string): number => {
    const known = level.get(name);
    if (known !== undefined) return known;
    const cycleStart = visiting.indexOf(name);
    if (cycleStart !== -1) {
      throw new Error(`Circular dependency: ${[...visiting.slice(cycleStart), name].join(' -> ')}`);
    }
    visiting.push(name);
    const deps = byName.get(name)?.dependencies ?? [];
    const own = deps.length === 0 ? 0 : Math.max(...deps.map(visit)) + 1;
    visiting.pop();
    level.set(name, own);
    return own;
  };

  const levels: string[][] = [];
  for (const node of nodes) {
    const index = visit(node.name);
    (levels[index] ??= []).push(node.name);
  }
  // Every level up to the deepest one is populated, because each app sits one above its deepest dependency
  return levels;
}
