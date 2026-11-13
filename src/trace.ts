import type { GraphEvent } from "./graph.js";

export function consoleTracer() {
  const pad = (node: string) => "  ".repeat(node.split("/").length);
  const label = (n: string) => (n === "__end__" ? "end" : n);

  const onEvent = (e: GraphEvent) => {
    switch (e.type) {
      case "step_start":
        console.log(`\n── step ${e.step}: ${e.frontier.join(" ∥ ")}`);
        break;
      case "node_end":
        console.log(`${pad(e.node)}✓ ${e.node} (${(e.ms / 1000).toFixed(1)}s) wrote [${Object.keys(e.update).join(", ")}]`);
        break;
      case "route":
        if (e.from !== "__start__") console.log(`${pad(e.from)}↳ ${e.from} → ${e.to.map(label).join(", ")}`);
        break;
      case "log":
        console.log(`${pad(e.node)}· ${e.node}: ${e.message}`);
        break;
    }
  };

  return { onEvent };
}
