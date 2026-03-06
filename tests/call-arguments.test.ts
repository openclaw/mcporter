import { describe, expect, it, vi } from 'vitest';
import { parseCallArguments } from '../src/cli/call-arguments.js';

describe('parseCallArguments', () => {
  it('parses legacy selector + key=value pairs', () => {
    const args = ['linear.list_documents', 'limit=5', 'format=json'];
    const parsed = parseCallArguments([...args]);
    expect(parsed.selector).toBe('linear.list_documents');
    expect(parsed.tool).toBeUndefined();
    expect(parsed.args.limit).toBe(5);
    expect(parsed.args.format).toBe('json');
  });

  it('consumes function-style call expressions with HTTP selectors', () => {
    const call = 'https://example.com/mcp.getComponents(limit: 3, projectId: "123")';
    const parsed = parseCallArguments([call]);
    expect(parsed.server).toBe('https://example.com/mcp');
    expect(parsed.tool).toBe('getComponents');
    expect(parsed.args.limit).toBe(3);
    expect(parsed.args.projectId).toBe('123');
  });

  it('merges --args JSON blobs with positional fragments', () => {
    const parsed = parseCallArguments([
      '--args',
      '{"query":"open issues"}',
      'linear',
      'list_documents',
      'orderBy=updatedAt',
    ]);
    expect(parsed.selector).toBe('linear');
    expect(parsed.tool).toBe('list_documents');
    expect(parsed.args.query).toBe('open issues');
    expect(parsed.args.orderBy).toBe('updatedAt');
  });

  it('throws when flags conflict with call expression content', () => {
    expect(() => parseCallArguments(['--server', 'linear', 'cursor.list_documents(limit:1)'])).toThrow(
      /Conflicting server names/
    );
  });

  it('warns when colon-style arguments omit a value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = parseCallArguments(['iterm-mcp.write_to_terminal', 'command:']);
    expect(parsed.args.command).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[mcporter] Argument 'command' was provided without a value.")
    );
    warnSpy.mockRestore();
  });

  it('tolerates LLM flag hallucinations (strips leading dashes)', () => {
    const parsed = parseCallArguments(['linear.get_issue', '--id=VINC-1', '--includeRelations', 'true']);
    expect(parsed.args.id).toBe('VINC-1');
    expect(parsed.args.includeRelations).toBe(true);
    expect(parsed.args['--id']).toBeUndefined();
  });

  it('tolerates LLM flag hallucinations spaced format', () => {
    const parsed = parseCallArguments(['linear.get_issue', '--id', 'VINC-1', '--dryRun', '--team', 'ENG']);
    expect(parsed.args.id).toBe('VINC-1');
    expect(parsed.args.dryRun).toBe(true);
    expect(parsed.args.team).toBe('ENG');
    expect(parsed.args['--id']).toBeUndefined();
  });
});
