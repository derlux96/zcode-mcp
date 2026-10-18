// Output of the installer and the doctor: one JSON document on stdout (--json,
// human text then goes to stderr) or human text on stdout.

function humanLines(title, report) {
  const lines = [`${title} ${report.version} — user ${report.user}, home ${report.home}`];
  for (const s of report.steps) {
    lines.push(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name}: ${s.detail}`);
    if (s.fix) lines.push(`      ${s.ok ? 'note' : 'fix'}: ${s.fix}`);
  }
  if (report.providers && report.providers.length) {
    lines.push('providers (key presence only, never the key):');
    for (const p of report.providers) {
      const key = p.keyPresent === null ? 'n/a' : p.keyPresent ? 'present' : 'MISSING';
      lines.push(`  ${p.id}  enabled=${p.enabled}  access=${p.access} (${p.accessType})  apiType=${p.apiType}  baseUrl=${p.baseUrl}  key=${key}`);
    }
  }
  for (const r of report.registered) lines.push(`registered: ${r.target} ${r.name} -> ${r.status}${r.scope ? ` (scope ${r.scope})` : ''}`);
  for (const f of report.files) lines.push(`file: ${f.action} ${f.path}`);
  if (report.nextSteps.length) {
    lines.push('next steps:');
    for (const n of report.nextSteps) lines.push(`  - ${n}`);
  }
  lines.push(report.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  return lines;
}

export function emit(title, report, { json, stdout = process.stdout, stderr = process.stderr }) {
  const text = `${humanLines(title, report).join('\n')}\n`;
  if (json) {
    stderr.write(text);
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout.write(text);
  }
}
