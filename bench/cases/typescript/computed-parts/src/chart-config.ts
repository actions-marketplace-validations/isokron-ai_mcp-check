import { z } from 'zod';
import config from '../charts.config.json' with { type: 'json' };

export function describeChart(kind: string): string {
  return config.descriptions[kind] ?? 'Renders a chart.';
}

export function chartArgs() {
  return Object.fromEntries(config.args.map((a: { name: string; help: string }) => [a.name, z.string().describe(a.help)]));
}

export function chartHints() {
  return { readOnlyHint: config.readOnly, openWorldHint: false };
}
