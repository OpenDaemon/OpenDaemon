import { describe, it, expect } from 'vitest';
import { parseYaml, YamlError } from '../../packages/plugins/config-manager/src/yaml.js';

describe('parseYaml', () => {
  it('should parse a realistic config with nested apps and plugins', () => {
    const yaml = [
      '# OpenDaemon config',
      'daemon:',
      '  logDir: ./logs',
      '  shutdownTimeout: 10000',
      'apps:',
      '  - name: api',
      '    script: ./dist/server.js',
      '    instances: 4',
      '    env:',
      '      NODE_ENV: production',
      '      PORT: "3000"',
      '  - name: worker',
      '    script: ./dist/worker.js',
      '    autoRestart: on-failure',
      'plugins:',
      '  webui:',
      '    port: 7777',
      '    password: "p#ss: word" # trailing comment',
    ].join('\n');

    expect(parseYaml(yaml)).toEqual({
      daemon: { logDir: './logs', shutdownTimeout: 10000 },
      apps: [
        { name: 'api', script: './dist/server.js', instances: 4, env: { NODE_ENV: 'production', PORT: '3000' } },
        { name: 'worker', script: './dist/worker.js', autoRestart: 'on-failure' },
      ],
      plugins: { webui: { port: 7777, password: 'p#ss: word' } },
    });
  });

  it('should parse scalars', () => {
    expect(parseYaml([
      'int: 42',
      'neg: -7',
      'float: 1.5',
      'yes: true',
      'no: false',
      'nothing: null',
      'tilde: ~',
      'empty:',
      "single: 'it''s'",
      'double: "a\\tb"',
      'url: http://localhost:3000/path',
      'colon: a:b',
      'emoji: 🚀 ok # comment after astral char',
    ].join('\n'))).toEqual({
      int: 42, neg: -7, float: 1.5, yes: true, no: false, nothing: null, tilde: null,
      empty: null, single: "it's", double: 'a\tb', url: 'http://localhost:3000/path', colon: 'a:b',
      emoji: '🚀 ok',
    });
  });

  it('should parse sequences: scalars, flow, same-indent, nested and empty items', () => {
    expect(parseYaml([
      'args:',
      '- --port',
      '- 3000',
      'flow: [a, "b, c", 3]',
      'none: []',
      'obj: {}',
      'matrix:',
      '  - - 1',
      '    - 2',
      '  -',
      '    k: v',
    ].join('\n'))).toEqual({
      args: ['--port', 3000],
      flow: ['a', 'b, c', 3],
      none: [],
      obj: {},
      matrix: [[1, 2], { k: 'v' }],
    });
  });

  it('should return an empty object for an empty document', () => {
    expect(parseYaml('# only comments\n\n---\n')).toEqual({});
  });

  it.each([
    ['tab indentation', 'a:\n\tb: 1', /Tabs are not allowed.*line 2/],
    ['unexpected indentation', 'a: 1\n    b: 2', /Unexpected indentation.*line 2/],
    ['duplicate keys', 'a: 1\na: 2', /Duplicate key "a".*line 2/],
    ['list item inside a mapping', 'a: 1\n- b', /Unexpected list item.*line 2/],
    ['missing colon', 'just text', /Expected "key: value"/],
    ['unterminated string', 'a: "oops', /Unterminated string/],
    ['flow mapping', 'a: {b: 1}', /Flow mappings are not supported/],
  ])('should reject %s with a line-numbered error', (_name, input, message) => {
    expect(() => parseYaml(input)).toThrow(YamlError);
    expect(() => parseYaml(input)).toThrow(message);
  });
});
