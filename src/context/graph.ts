import * as vscode from "vscode";

export interface GraphNode {
  id: string;
  name: string;
  filePath: string;
  type: "class" | "function" | "file" | "module";
  references: string[];    // ids of nodes this references
  referencedBy: string[];  // ids of nodes referencing this
  lastModified: number;
  callFrequency: number;
}

export interface ContextGraph {
  nodes: Map<string, GraphNode>;
  lastBuilt: number;
}

const graph: ContextGraph = { nodes: new Map(), lastBuilt: 0 };

async function scanWorkspace(): Promise<GraphNode[]> {
  const nodes: GraphNode[] = [];
  try {
    const files = await vscode.workspace.findFiles(
      "**/*.{ts,js,tsx,jsx,py,cs,java}",
      "{**/node_modules/**,**/.git/**,**/out/**}",
      200
    );

    for (const file of files) {
      const segments = file.fsPath.replace(/\\/g, "/").split("/");
      const filename = segments[segments.length - 1];
      const name = filename.replace(/\.[^.]+$/, "");

      let stat: { mtime: Date } | undefined;
      try {
        stat = await vscode.workspace.fs
          .stat(file)
          .then((s) => ({ mtime: new Date(s.mtime) }));
      } catch {
        stat = undefined;
      }

      nodes.push({
        id: file.toString(),
        name,
        filePath: file.fsPath,
        type: "file",
        references: [],
        referencedBy: [],
        lastModified: stat ? stat.mtime.getTime() : Date.now(),
        callFrequency: 0,
      });
    }
  } catch {
    // No workspace open — silently return empty
  }
  return nodes;
}

export async function buildGraph(): Promise<ContextGraph> {
  const nodes = await scanWorkspace();
  graph.nodes.clear();
  for (const node of nodes) {
    graph.nodes.set(node.id, node);
  }
  graph.lastBuilt = Date.now();
  return graph;
}

export function getGraph(): ContextGraph {
  return graph;
}

export function incrementNodeFrequency(nodeId: string): void {
  const node = graph.nodes.get(nodeId);
  if (node) {
    node.callFrequency++;
  }
}
