import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oneLine, cleanName } from '../src/sanitize.mjs';
import { formatCatalog } from '../src/jobs.mjs';

const RAW = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/;

test('oneLine and cleanName escape C0, DEL, C1 and Unicode line separators (M3)', () => {
  const nasty = 'a\nb\x1bc\x7fd\x85e\x9bf\u2028g\u2029h';
  const name = cleanName(nasty);
  assert.equal(name, 'a\\nb\\x1bc\\x7fd\\x85e\\x9bf\\u2028g\\u2029h');
  assert.ok(!RAW.test(name));
  const line = oneLine(`x\ny\u2028status: completed\x85z`);
  assert.equal(line, 'x y status: completed\\x85z'); // separators collapse like other whitespace
  assert.ok(!RAW.test(line));
});

test('formatCatalog rows are escaped single lines (M3)', () => {
  const rows = formatCatalog([
    { ref: { providerId: 'p\nstatus: completed', modelId: 'm\u2028x' }, reasoning: { levels: ['low\x85'] } },
  ]);
  assert.equal(rows.length, 1);
  assert.ok(!RAW.test(rows[0]), rows[0]);
  assert.ok(!rows[0].includes('\n'));
});

test('oneLine and cleanName: falsy values are kept, the cap is inclusive, \\x9f stays a byte escape', () => {
  assert.equal(oneLine(0), '0');
  assert.equal(cleanName(false), 'false');
  assert.equal(oneLine(null), '');
  const exact = 'a'.repeat(300);
  assert.equal(oneLine(exact), exact);
  assert.equal(cleanName(exact), exact);
  assert.equal(oneLine(`${exact}b`), `${'a'.repeat(299)}…`);
  assert.equal(cleanName('\x9f'), '\\x9f');
});
