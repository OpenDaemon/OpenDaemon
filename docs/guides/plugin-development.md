# Plugin Development

Every feature of OpenDaemon is a plugin. This guide shows how the built-in ones are put together, so you can add your own.

> The daemon registers a fixed list of plugins in `packages/cli/src/daemon.ts`. Loading third-party plugins from the config file is not implemented yet: a new plugin is added to that list.

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
