import Anthropic from '@anthropic-ai/sdk';
import type { ReportedLeak } from './check.ts';

export type Verdict = 'equivalent' | 'behavior-change' | 'unclear';

export interface Triage {
  verdict: Verdict;
  reason: string;
  model: string;
}

export interface TriageOptions {
  /** Default `claude-opus-5-5`. */
  model?: string;
  /** Default `medium`. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Canonical keys of the new flags. */
  newFlags: string[];
  /** Both versions of each changed file, by path. */
  sources: Map<string, { base: string | null; head: string | null }>;
  /** Injected in tests. Default: `new Anthropic()`, which reads ANTHROPIC_API_KEY. */
  client?: Pick<Anthropic, 'beta'>;
  concurrency?: number;
}

export interface TriageRun {
  /** Leaks that got a verdict. */
  triaged: number;
  /** Set when triage didn't run at all, e.g. no credentials. */
  skipped?: string;
  /** Per-leak failures, by `file:line`. */
  errors: string[];
  usage: { input: number; output: number; cacheRead: number };
}

/** Only code leaks at error severity get a second opinion: not allowed, additive or test findings. */
const TRIAGED_KINDS = new Set(['ungated-modification', 'ungated-deletion', 'reachable-addition']);

// Stable across every request, so it's cached: keep anything per-leak out of it.
const SYSTEM = `You review changes on a feature branch that is meant to be fully behind new feature flags. With every new flag off, the branch must behave exactly like the base branch.

A static checker, gatecheck, turned the new flags off in the branch's code, simplified it, and found that the marked change still differs from the base. It compares code structure, so it also reports rewrites that behave the same. Decide which this is.

Verdicts:
- equivalent: with the new flags off, nobody could observe the change. Same return values, same side effects (I/O, network, logging, mutations, timing-visible work), same errors, and the same types and shapes at module and API boundaries. Renamed locals, extracted helpers, reordered pure expressions and formatting are equivalent.
- behavior-change: some input, user or caller would see a difference with the new flags off. This includes changed API shapes and signatures. A change that looks intentional is still a behavior change.
- unclear: the answer depends on code you can't see, such as what a called function does. Say what you would need to see.

Judge only the marked lines and what they affect. Don't let apparent intent excuse a change. Write the reason as one or two plain sentences that name the concrete difference, or say why there is none.`;

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['equivalent', 'behavior-change', 'unclear'] },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
  additionalProperties: false,
};

/** Whole file with line numbers and the leak's lines marked; a window around them for long files. */
function excerpt(source: string | null, from: number | undefined, to: number | undefined): string {
  if (source === null) return '(file does not exist on this side)';
  const lines = source.split('\n');
  const window = lines.length > 600 && from !== undefined ? [Math.max(1, from - 60), Math.min(lines.length, (to ?? from) + 60)] : [1, lines.length];
  const out: string[] = [];
  if (window[0] > 1) out.push(`… (lines 1-${window[0] - 1} omitted)`);
  for (let n = window[0]; n <= window[1]; n++) {
    const marked = from !== undefined && n >= from && n <= (to ?? from);
    out.push(`${marked ? '>>' : '  '} ${String(n).padStart(4)} | ${lines[n - 1]}`);
  }
  if (window[1] < lines.length) out.push(`… (lines ${window[1] + 1}-${lines.length} omitted)`);
  return out.join('\n');
}

function prompt(leak: ReportedLeak, newFlags: string[], source: { base: string | null; head: string | null } | undefined): string {
  return [
    `New flags (all off): ${newFlags.join(', ') || 'none detected'}`,
    `File: ${leak.file}`,
    `Reported as ${leak.kind} in ${leak.decl}, branch lines ${leak.head.line}-${leak.head.endLine}${leak.base ? `, base lines ${leak.base.line}-${leak.base.endLine}` : ''}. Marked lines start with >>.`,
    '',
    '<base>',
    excerpt(source?.base ?? null, leak.base?.line, leak.base?.endLine),
    '</base>',
    '',
    '<branch>',
    excerpt(source?.head ?? null, leak.kind === 'ungated-deletion' ? undefined : leak.head.line, leak.head.endLine),
    '</branch>',
  ].join('\n');
}

class NoCredentials extends Error {}
class SetupError extends Error {}
/** The model answered, but not in the shape asked for. */
class ResponseError extends Error {}

/**
 * Asks Claude whether each remaining code leak is an equivalent rewrite or a real
 * behavior change. Sets `leak.triage`; never changes severity. API failures are
 * recorded and skipped, so triage can't fail a check.
 */
export async function triageLeaks(leaks: ReportedLeak[], options: TriageOptions): Promise<TriageRun> {
  const { model = 'claude-opus-5-5', effort = 'medium', newFlags, sources, concurrency = 4 } = options;
  const run: TriageRun = { triaged: 0, errors: [], usage: { input: 0, output: 0, cacheRead: 0 } };
  const todo = leaks.filter((l) => TRIAGED_KINDS.has(l.kind) && l.severity === 'error');
  if (todo.length === 0) return run;

  let client: Pick<Anthropic, 'beta'>;
  try {
    client = options.client ?? new Anthropic();
  } catch (err) {
    return { ...run, skipped: `no Anthropic API credentials (${(err as Error).message.split('\n')[0]})` };
  }

  const one = async (leak: (typeof todo)[number]) => {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 4000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt(leak, newFlags, sources.get(leak.file)) }],
      output_config: { effort, format: { type: 'json_schema', schema: SCHEMA } },
      // If a safety classifier declines, the API re-runs the request on its recommended fallback.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    run.usage.input += response.usage.input_tokens;
    run.usage.output += response.usage.output_tokens;
    run.usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    if (response.stop_reason === 'refusal') {
      leak.triage = { verdict: 'unclear', reason: 'Claude declined to assess this change.', model: response.model };
      run.triaged++;
      return;
    }
    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') throw new ResponseError(`no text in the response (stop_reason ${response.stop_reason})`);
    let parsed: { verdict: Verdict; reason: string };
    try {
      parsed = JSON.parse(text.text);
    } catch {
      throw new ResponseError(`the response wasn't JSON: ${text.text.slice(0, 80)}`);
    }
    leak.triage = { verdict: parsed.verdict, reason: parsed.reason, model: response.model };
    run.triaged++;
  };

  const handle = async (leak: (typeof todo)[number]) => {
    try {
      await one(leak);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new NoCredentials(err.message);
      // Anything that's neither an API response nor a bad answer (e.g. the SDK found no
      // credentials) is a setup problem, not this leak's: stop once.
      if (!(err instanceof Anthropic.APIError) && !(err instanceof ResponseError)) throw new SetupError((err as Error).message);
      const what = err instanceof Anthropic.APIError ? `API error ${err.status}: ${err.message}` : err.message;
      run.errors.push(`${leak.file}:${leak.head.line}: ${what}`);
    }
  };

  // The first leak goes alone, so a setup problem costs one attempt; then a small pool,
  // fast enough and gentle on rate limits (the SDK also retries 429s).
  const queue = [...todo];
  const drain = async () => {
    for (let leak = queue.shift(); leak; leak = queue.shift()) await handle(leak);
  };
  try {
    await handle(queue.shift()!);
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, drain));
  } catch (err) {
    if (err instanceof NoCredentials) return { ...run, skipped: `Anthropic API rejected the credentials: ${err.message}` };
    if (err instanceof SetupError) return { ...run, skipped: `${err.message.split('.')[0]}. Set ANTHROPIC_API_KEY.` };
    throw err;
  }
  return run;
}
