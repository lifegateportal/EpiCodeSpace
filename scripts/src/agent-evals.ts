type EvalTask = {
  id: string;
  category: 'bugfix' | 'refactor' | 'scaffold' | 'review' | 'test';
  prompt: string;
  expectedSignals: string[];
};

type EvalRun = {
  taskId: string;
  success: boolean;
  toolCalls: number;
  writeCalls: number;
  readCalls: number;
  durationMs: number;
  notes?: string;
};

const GOLDEN_TASKS: EvalTask[] = [
  {
    id: 'bugfix-react-null-guard',
    category: 'bugfix',
    prompt: 'Fix the active React component crash: Cannot read properties of undefined (reading name).',
    expectedSignals: ['optional chaining', 'guard clause', 'analyzeFile'],
  },
  {
    id: 'refactor-duplicate-logic',
    category: 'refactor',
    prompt: 'Refactor duplicate helper logic into a shared utility and update imports.',
    expectedSignals: ['shared utility', 'import update', 'no regressions'],
  },
  {
    id: 'scaffold-component',
    category: 'scaffold',
    prompt: 'Create a typed React component with props, loading state, and empty state.',
    expectedSignals: ['createComponent', 'typescript', 'states covered'],
  },
  {
    id: 'review-security',
    category: 'review',
    prompt: 'Review the file for security and runtime risks and prioritize findings.',
    expectedSignals: ['severity ordering', 'xss', 'runtime'],
  },
  {
    id: 'test-regression',
    category: 'test',
    prompt: 'Add unit tests for edge cases and async failure behavior.',
    expectedSignals: ['test cases', 'async failure', 'edge case'],
  },
];

function scoreRun(run: EvalRun): number {
  let score = 0;
  if (run.success) score += 60;
  score += Math.max(0, 20 - run.readCalls * 2);
  score += Math.min(15, run.writeCalls * 3);
  score += Math.max(0, 10 - Math.floor(run.durationMs / 2000));
  return Math.max(0, Math.min(100, score));
}

function printTemplate(): void {
  console.log('EpiCodeSpace Agent Eval Harness');
  console.log('================================');
  console.log('Golden tasks:');
  for (const task of GOLDEN_TASKS) {
    console.log(`- ${task.id} [${task.category}]`);
    console.log(`  prompt: ${task.prompt}`);
    console.log(`  expected: ${task.expectedSignals.join(', ')}`);
  }
  console.log('');
  console.log('How to use:');
  console.log('1. Run each task against the chat agent manually or via automation.');
  console.log('2. Save per-task telemetry as JSON with fields:');
  console.log('   taskId, success, toolCalls, writeCalls, readCalls, durationMs, notes');
  console.log('3. Pipe those runs into a scorer (sample below).');
}

function main(): void {
  printTemplate();

  const sampleRuns: EvalRun[] = GOLDEN_TASKS.map((task, index) => ({
    taskId: task.id,
    success: false,
    toolCalls: 0,
    writeCalls: 0,
    readCalls: 0,
    durationMs: 1000 + index * 500,
    notes: 'Replace sample values with actual telemetry.',
  }));

  console.log('');
  console.log('Sample scoring output (replace with real runs):');
  let total = 0;
  for (const run of sampleRuns) {
    const s = scoreRun(run);
    total += s;
    console.log(`- ${run.taskId}: ${s}/100`);
  }
  const avg = sampleRuns.length ? Math.round(total / sampleRuns.length) : 0;
  console.log(`Average: ${avg}/100`);
}

main();
