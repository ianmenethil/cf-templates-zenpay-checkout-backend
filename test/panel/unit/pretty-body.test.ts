import { describe, expect, it } from 'vitest';
import { prettyBody } from '@/lib/pretty-body';

describe('prettyBody', () => {
  it('indents an object by two spaces', () => {
    expect(prettyBody('{"a":1,"b":{"c":[1,2]}}')).toBe(JSON.stringify({ a: 1, b: { c: [1, 2] } }, null, 2));
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it('indents an array', () => {
    expect(prettyBody('[1,{"a":2}]')).toBe('[\n  1,\n  {\n    "a": 2\n  }\n]');
  });

  it('keeps an empty object and an empty array readable', () => {
    expect(prettyBody('{}')).toBe('{}');
    expect(prettyBody('[]')).toBe('[]');
  });

  it.each(['42', '"text"', 'true', 'false', '  7  '])('returns the scalar %s as it arrived', (body) => {
    expect(prettyBody(body)).toBe(body);
  });

  it('returns null as it arrived', () => {
    expect(prettyBody('null')).toBe('null');
  });

  it.each(['', 'not json at all', '{"a":', "{'a':1}", '<html></html>'])('returns text that is not JSON as it arrived: %j', (body) => {
    expect(prettyBody(body)).toBe(body);
  });
});
