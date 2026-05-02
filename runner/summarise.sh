#!/usr/bin/env bash
# Walks results/ and emits a summary table across all runs.
# Usage: ./runner/summarise.sh

set -euo pipefail
RIG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RIG_ROOT"

node <<'JS'
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = "results";
if (!existsSync(root)) { console.log("no results yet"); process.exit(0); }

const cells = readdirSync(root).filter(d => {
  try { return readdirSync(join(root, d)).length > 0; } catch { return false; }
});

const summary = {};
for (const cell of cells) {
  const runs = readdirSync(join(root, cell)).filter(r => r.startsWith("run-"));
  const cellData = [];
  for (const run of runs) {
    const metricsPath = join(root, cell, run, "metrics.json");
    if (!existsSync(metricsPath)) continue;
    const m = JSON.parse(readFileSync(metricsPath, "utf8"));
    cellData.push(m);
  }
  if (cellData.length === 0) continue;
  const passes = cellData.map(d => d.tests.passed);
  const totals = cellData.map(d => d.tests.total);
  const passRates = cellData.map(d => d.tests.total > 0 ? d.tests.passed / d.tests.total : 0);
  const wallClocks = cellData.map(d => d.manual_fields?.wall_clock_seconds).filter(x => x != null);
  const toolCalls = cellData.map(d => d.manual_fields?.tool_calls).filter(x => x != null);
  const clarifying = cellData.map(d => d.manual_fields?.clarifying_questions).filter(x => x != null);
  const earlyStops = cellData.filter(d => d.manual_fields?.early_stop === true).length;

  summary[cell] = {
    runs: cellData.length,
    pass_rate_pct: Math.round(passRates.reduce((a,b)=>a+b,0) / passRates.length * 100),
    median_wall_clock_s: median(wallClocks),
    median_tool_calls: median(toolCalls),
    total_clarifying_qs: clarifying.reduce((a,b)=>a+b,0),
    early_stops: `${earlyStops}/${cellData.length}`,
    median_diff_lines: median(cellData.map(d => d.diff_lines).filter(x => x != null)),
  };
}

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a,b)=>a-b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid-1] + sorted[mid]) / 2);
}

const cols = ["runs","pass_rate_pct","median_wall_clock_s","median_tool_calls","total_clarifying_qs","early_stops","median_diff_lines"];
const harnessW = Math.max(15, ...Object.keys(summary).map(s=>s.length));
const colW = 18;

console.log("\nResults summary\n");
console.log("harness".padEnd(harnessW) + " | " + cols.map(c=>c.padEnd(colW)).join("| "));
console.log("-".repeat(harnessW) + "-+-" + cols.map(()=>"-".repeat(colW)).join("+-"));
for (const [h, s] of Object.entries(summary)) {
  const row = cols.map(c => String(s[c] ?? "—").padEnd(colW)).join("| ");
  console.log(h.padEnd(harnessW) + " | " + row);
}
console.log("\n(Manual fields are blank where you haven't filled them in yet.)");
JS
