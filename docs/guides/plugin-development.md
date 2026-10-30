# Plugin Development

Every feature of OpenDaemon is a plugin. This guide shows how the built-in ones are put together, so you can add your own.

> Built-in plugins are registered in `packages/cli/src/daemon.ts`. Your own plugin does not need to be: list it under `extensions` in the config file (see [Loading your plugin](#loading-your-plugin)).

## Shape of a plugin

```ts
import type { Plugin, PluginContext } from '../../../core/src/index.js';

export class HelloPlugin implements Plugin {
  name = 'hello';
  version = '1.0.0';
  description = 'Says hello';
  priority = 50;                       // lower loads first

  // Set in install(), which the kernel always calls before any other hook
  private context!: PluginContext;

  install(context: PluginContext): void {
    this.context = context;
    const { greeting = 'hello' } = (context.pluginConfig ?? {}) as { greeting?: string };

    // 1. RPC method: reachable from the CLI, the SDK and other plugins
    context.registerMethod('hello', (params: unknown) => {
      const { who } = (params ?? {}) as { who?: string };
      return Promise.resolve(`${greeting}, ${who ?? 'world'}`);
    });

    // 2. React to daemon events
    context.events.on('process:crash', (data: unknown) => {
      context.logger.warn('A process crashed', data);
    });
  }

  onStop(): void { /* release timers, sockets, file handles */ }
}
```

## Lifecycle

| Hook | When |
|------|------|
| `install(context)` | Registered with the kernel. Register RPC methods and event handlers here. Other plugins may not be installed yet |
| `onStart(context)` | After every plugin is installed. Start servers and timers here |
| `onReady(context)` | The daemon accepts commands |
| `onStop(context)` | Graceful shutdown; finish within `shutdownTimeout`. Plugins stop in reverse order |

## The context

| Member | Use |
|--------|-----|
| `pluginConfig` | The plugin's section of `plugins: { <name>: ... }` in the config |
| `events` | Event bus: `on`, `once`, `emit`; wildcards such as `process:*` |
| `logger` | Structured logger scoped to the plugin |
| `store` | Shared key-value state with subscriptions |
| `registerMethod(name, fn)` | Expose an RPC method |
| `getPlugin(name)` | A reference to another plugin, or `undefined` |

## Events you can rely on

`process:started`, `process:stopped`, `process:crash`, `process:log`, `process:memory-limit`, `process:cpu-limit`, `health:status:healthy`, `health:status:unhealthy`, `watch:change`, `cron:run`, `cron:finish`, `config:reloaded`, `daemon:ready`, `daemon:stopped`, `auth:login`.

The notification and audit-logger plugins are the best examples of event-driven plugins: both are a table of events plus a sink.

## Rules the built-in plugins follow

- **No runtime dependencies.** Use `node:` built-ins only; `package.json` `dependencies` stays empty.
- **Never let a plugin take the daemon down.** Catch errors from I/O you do not control and log them (see `AuditLoggerPlugin.record`).
- **Never log secrets.** Pass anything that may hold credentials through `redact()` from the audit-logger.
- **Bind to loopback and authenticate** if you open a port (see the WebUI plugin).
- **Clean up in `onStop`.** `unref()` timers and close servers so shutdown is prompt.

## Testing

Plugins are tested without a kernel by handing them a minimal context (see `tests/integration/secret-manager.test.ts`):

```ts
const context = {
  config: {}, events: new EventBus(), logger: new Logger('t'), store: new StateStore(),
  registerMethod: (name, fn) => methods.set(name, fn),
  getPlugin: (name) => plugins[name],
} as unknown as PluginContext;
plugin.install(context);
```

Then call `methods.get('hello')` and emit events on `context.events`. Add the plugin's `src` to the coverage `include` in `vitest.config.ts`.

## Loading your plugin

Name the module under `extensions` in the config file. A path is relative to the config file, a bare name is a package resolved from the config file's directory:

```yaml
extensions:
  - ./plugins/hello.mjs
  - opendaemon-plugin-pagerduty
plugins:
  hello:                 # the settings arrive as context.pluginConfig
    greeting: hi
```

The module exports the plugin as its default (or as a named `plugin`): an instance, a class with a no-argument constructor, or a function that returns one (it may be async).

```js
// plugins/hello.mjs
export default class Hello {
  name = 'hello';
  version = '1.0.0';
  install(context) {
    context.registerMethod('hello', () => ({ greeting: context.pluginConfig?.greeting ?? 'hello' }));
  }
}
```

- Extensions are registered after the built-in plugins, in the order listed, so they can reach the built-in ones with `context.getPlugin(...)`. A plugin name that is already taken is refused.
- An extension that cannot be loaded (missing file, error on import, not a plugin, name taken) is logged and skipped; the daemon starts without it.
- Extensions run inside the daemon with its privileges, so load only code you trust. The config file is as sensitive as the code it points to.
- Changes to `extensions` take effect when the daemon restarts.
