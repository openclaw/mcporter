export function renderEmbeddedHelpSource(): string {
  return `function configureGeneratedCommandHelp(command: Command): void {
\tcommand.configureHelp({
\t\tcommandUsage(target) {
\t\t\tconst usage = (target.name() + ' ' + target.usage()).trim() || target.name();
\t\t\treturn supportsAnsiColor ? tint.bold(usage) : usage;
\t\t},
\t\toptionTerm(option) {
\t\t\tconst term = option.flags ?? '';
\t\t\treturn supportsAnsiColor ? tint.bold(term) : term;
\t\t},
\t\toptionDescription(option) {
\t\t\tconst description = option.description ?? '';
\t\t\treturn supportsAnsiColor ? tint.extraDim(description) : description;
\t\t},
\t});
}

function configureToolCommandHelps(): void {
\tprogram.commands.forEach((cmd) => {
\t\tif (cmd.name() === '__mcporter_inspect') {
\t\t\treturn;
\t\t}
\t\tconfigureGeneratedCommandHelp(cmd);
\t});
}

function renderStandaloneHelp(): string {
\tconst colorfulTitle = tint.bold(embeddedName) + ' ' + tint.dim('— ' + embeddedDescription);
\tconst plainTitle = embeddedName + ' — ' + embeddedDescription;
\tconst title = supportsAnsiColor ? colorfulTitle : plainTitle;
\tconst lines = [title, '', 'Usage: ' + embeddedName + ' <command> [options]', ''];
\tif (generatorTools) {
\t\tlines.push(formatEmbeddedTools());
\t}
\tlines.push('', formatGlobalFlags(), '', formatQuickStart());
\tif (generatorInfo) {
\t\tlines.push('', tint.extraDim(generatorInfo));
\t}
\treturn lines.join('\\n');
}

program.helpInformation = () => renderStandaloneHelp();

function formatEmbeddedTools(): string {
\tconst header = supportsAnsiColor ? tint.bold('Embedded tools') : 'Embedded tools';
\tif (!generatorTools.length) {
\t\treturn header;
\t}
\tconst lines = [header];
\tgeneratorTools.forEach((entry) => {
\t\tconst renderedDesc = entry.description
\t\t\t? supportsAnsiColor
\t\t\t\t? tint.extraDim(entry.description)
\t\t\t\t: entry.description
\t\t\t: undefined;
\t\tconst base = renderedDesc ? entry.name + ' - ' + renderedDesc : entry.name;
\t\tlines.push('  ' + base);
\t\tif (entry.flags) {
\t\t\tconst renderedFlags = supportsAnsiColor ? tint.extraDim(entry.flags) : entry.flags;
\t\t\tlines.push('    ' + renderedFlags);
\t\t}
\t\tlines.push('');
\t});
\tif (lines[lines.length - 1] === '') {
\t\tlines.pop();
\t}
\treturn lines.join('\\n');
}

function formatGlobalFlags(): string {
\tconst header = supportsAnsiColor ? tint.bold('Global flags') : 'Global flags';
\tconst entries = [
\t\t['-t, --timeout <ms>', 'Call timeout in milliseconds'],
\t\t['-o, --output <format>', 'text | markdown | json | raw (default text)'],
\t];
\tconst formatted = entries.map(([flag, summary]) => '  ' + flag.padEnd(28) + summary);
\treturn [header, ...formatted].join('\\n');
}

function formatQuickStart(): string {
  const header = supportsAnsiColor ? tint.bold('Quick start') : 'Quick start';
  const examples = quickStartExamples();
  if (!examples.length) {
    return header;
  }
  const formatted = examples.map(([cmd, note]) => '  ' + cmd + '\\n    ' + tint.dim('# ' + note));
  return [header, ...formatted].join('\\n');
}

function quickStartExamples(): Array<[string, string]> {
  const examples: Array<[string, string]> = [];
  const commandMap = new Map<string, string>();
  program.commands.forEach((cmd) => {
    const name = cmd.name();
    if (name !== '__mcporter_inspect') {
      commandMap.set(name, name);
    }
  });
  const embedded = Array.isArray(generatorTools) ? generatorTools : [];
  for (const entry of embedded.slice(0, 3)) {
    const commandName = commandMap.get(entry.name) ?? entry.name;
    const flags = entry.flags ? ' ' + entry.flags.replace(/<[^>]+>/g, '<value>') : '';
    examples.push([embeddedName + ' ' + commandName + flags, 'invoke ' + commandName]);
  }
  if (!examples.length) {
    examples.push([embeddedName + ' <tool> --key value', 'invoke a tool with flags']);
  }
  return examples;
}
`;
}
