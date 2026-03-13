#!/usr/bin/env tsx
/**
 * Performance benchmark script for MCPorter
 * 
 * Usage:
 *   tsx scripts/benchmark.ts
 *   tsx scripts/benchmark.ts --server linear
 *   tsx scripts/benchmark.ts --iterations 10
 */

import { performance } from 'node:perf_hooks';
import { createRuntime } from '../src/runtime.js';

interface BenchmarkResult {
  operation: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

async function benchmark(
  name: string,
  fn: () => Promise<void>,
  iterations = 5
): Promise<BenchmarkResult> {
  const times: number[] = [];

  // Warm-up run
  await fn();

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    const end = performance.now();
    times.push(end - start);
  }

  const totalMs = times.reduce((a, b) => a + b, 0);
  const avgMs = totalMs / iterations;
  const minMs = Math.min(...times);
  const maxMs = Math.max(...times);

  return {
    operation: name,
    iterations,
    totalMs,
    avgMs,
    minMs,
    maxMs,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const serverFlag = args.indexOf('--server');
  const iterFlag = args.indexOf('--iterations');
  
  const targetServer = serverFlag >= 0 ? args[serverFlag + 1] : 'context7';
  const iterations = iterFlag >= 0 ? Number.parseInt(args[iterFlag + 1], 10) : 5;

  console.log('🚀 MCPorter Performance Benchmark\n');
  console.log(`Target server: ${targetServer}`);
  console.log(`Iterations: ${iterations}\n`);

  const results: BenchmarkResult[] = [];

  // Benchmark 1: Runtime creation
  console.log('⏱️  Benchmarking runtime creation...');
  const runtimeResult = await benchmark(
    'createRuntime()',
    async () => {
      const runtime = await createRuntime();
      await runtime.close();
    },
    iterations
  );
  results.push(runtimeResult);

  // Benchmark 2: List servers
  console.log('⏱️  Benchmarking listServers()...');
  const runtime = await createRuntime();
  const listServersResult = await benchmark(
    'runtime.listServers()',
    async () => {
      runtime.listServers();
    },
    iterations * 2 // Faster operation, more iterations
  );
  results.push(listServersResult);

  // Benchmark 3: List tools (first call - no cache)
  console.log(`⏱️  Benchmarking listTools('${targetServer}') - cold...`);
  const listToolsColdResult = await benchmark(
    `listTools('${targetServer}') - cold`,
    async () => {
      const freshRuntime = await createRuntime();
      await freshRuntime.listTools(targetServer);
      await freshRuntime.close();
    },
    Math.max(3, Math.floor(iterations / 2)) // Slower, fewer iterations
  );
  results.push(listToolsColdResult);

  // Benchmark 4: List tools (cached)
  console.log(`⏱️  Benchmarking listTools('${targetServer}') - warm...`);
  await runtime.listTools(targetServer); // Prime cache
  const listToolsWarmResult = await benchmark(
    `listTools('${targetServer}') - warm`,
    async () => {
      await runtime.listTools(targetServer);
    },
    iterations
  );
  results.push(listToolsWarmResult);

  await runtime.close();

  // Print results
  console.log('\n📊 Results:\n');
  console.log('┌─────────────────────────────────────┬──────────┬──────────┬──────────┬──────────┐');
  console.log('│ Operation                           │ Avg (ms) │ Min (ms) │ Max (ms) │ Iters    │');
  console.log('├─────────────────────────────────────┼──────────┼──────────┼──────────┼──────────┤');

  for (const result of results) {
    const op = result.operation.padEnd(35);
    const avg = result.avgMs.toFixed(2).padStart(8);
    const min = result.minMs.toFixed(2).padStart(8);
    const max = result.maxMs.toFixed(2).padStart(8);
    const iters = result.iterations.toString().padStart(8);
    console.log(`│ ${op} │ ${avg} │ ${min} │ ${max} │ ${iters} │`);
  }

  console.log('└─────────────────────────────────────┴──────────┴──────────┴──────────┴──────────┘');

  // Calculate improvements
  const coldTime = results.find(r => r.operation.includes('cold'))?.avgMs ?? 0;
  const warmTime = results.find(r => r.operation.includes('warm'))?.avgMs ?? 0;
  
  if (coldTime > 0 && warmTime > 0) {
    const improvement = ((coldTime - warmTime) / coldTime * 100).toFixed(1);
    console.log(`\n💡 Cache improvement: ${improvement}% faster (${coldTime.toFixed(2)}ms → ${warmTime.toFixed(2)}ms)`);
  }

  // Export JSON for CI
  if (process.env.CI || process.env.MCPORTER_BENCH_JSON) {
    const json = JSON.stringify(results, null, 2);
    console.log('\n📄 JSON Output:\n');
    console.log(json);
  }
}

main().catch((error) => {
  console.error('❌ Benchmark failed:', error);
  process.exit(1);
});
