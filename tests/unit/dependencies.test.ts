import { describe, it, expect } from 'vitest';
import { dependencyLevels } from '../../packages/core/src/index.js';

describe('dependencyLevels', () => {
  it('should put independent apps in level 0, in config order', () => {
    expect(dependencyLevels([{ name: 'a' }, { name: 'b', dependencies: [] }])).toEqual([['a', 'b']]);
  });

  it('should level the spec example (diamond plus chain)', () => {
    expect(dependencyLevels([
      { name: 'gateway', dependencies: ['api'] },
      { name: 'database' },
      { name: 'api', dependencies: ['database', 'cache'] },
      { name: 'cache' },
      { name: 'worker', dependencies: ['database'] },
    ])).toEqual([['database', 'cache'], ['api', 'worker'], ['gateway']]);
  });

  it('should place an app one level above its deepest dependency', () => {
    expect(dependencyLevels([
      { name: 'a' },
      { name: 'b', dependencies: ['a'] },
      { name: 'c', dependencies: ['a', 'b'] },
    ])).toEqual([['a'], ['b'], ['c']]);
  });

  it.each([
    [[{ name: 'a', dependencies: ['a'] }], 'App "a" depends on itself'],
    [[{ name: 'a', dependencies: ['ghost'] }], 'App "a" depends on unknown app "ghost"'],
    [[{ name: 'a', dependencies: ['b'] }, { name: 'b', dependencies: ['c'] }, { name: 'c', dependencies: ['a'] }],
      'Circular dependency: a -> b -> c -> a'],
  ])('should reject %j', (apps, message) => {
    expect(() => dependencyLevels(apps)).toThrow(message);
  });
});
