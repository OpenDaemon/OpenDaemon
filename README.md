# OpenDaemon

Next-generation process manager for Node.js. Built with TypeScript, zero runtime dependencies, and a plugin-first architecture.

[![CI](https://github.com/opendaemon/opendaemon/actions/workflows/ci.yml/badge.svg)](https://github.com/opendaemon/opendaemon/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/opendaemon/opendaemon/branch/main/graph/badge.svg)](https://codecov.io/gh/opendaemon/opendaemon)
[![npm version](https://badge.fury.io/js/opendaemon.svg)](https://www.npmjs.com/package/opendaemon)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Zero Runtime Dependencies** - Everything built from scratch
- **Plugin-First Architecture** - Micro-kernel with extensible plugins
- **TypeScript Native** - Written in TypeScript, configured in TypeScript
- **Modern Process Management** - Fork and cluster modes, zero-downtime reloads
- **Health Checks** - HTTP, TCP, gRPC, and custom script-based health monitoring
- **Structured Logging** - JSON logs with rotation and compression
- **Secret Management** - AES-256 encrypted secret storage
- **TUI Dashboard** - Real-time terminal dashboard like htop
- **100% Test Coverage** - Every line tested
- **MIT Licensed** - Truly open source

## Quick Start

```bash
# Install globally
npm install -g opendaemon

# Start a process
od start app.js

# List processes
od list

# Monitor in real-time
od monit
```

## Configuration

```typescript
// opendaemon.config.ts
import { defineConfig } from 'opendaemon';

export default defineConfig({
  apps: [
    {
      name: 'api',
      script: './dist/api.js',
      instances: 4,
      healthCheck: {
        type: 'http',
        url: 'http://localhost:3000/health',
      },
    },
  ],
});
```

## Project Structure

```
opendaemon/
├── packages/
│   ├── core/          # Micro-kernel, event bus, state machine
│   ├── cli/           # Command-line interface
│   └── sdk/           # JavaScript/TypeScript SDK
├── tests/             # Unit, integration, and E2E tests
├── SPECIFICATION.md   # Complete system specification
├── IMPLEMENTATION.md  # Architecture and design decisions
└── TASKS.md          # Development task list
```

## Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Type check
npm run typecheck

# Lint
npm run lint
```

## Documentation

- [SPECIFICATION.md](./SPECIFICATION.md) - Complete system specification
- [IMPLEMENTATION.md](./IMPLEMENTATION.md) - Architecture and design decisions
- [TASKS.md](./TASKS.md) - Development task list
- [API Reference](https://opendaemon.dev/api)
- [Configuration Guide](https://opendaemon.dev/config)
- [CLI Reference](https://opendaemon.dev/cli)

## Why OpenDaemon?

OpenDaemon was created to address the limitations of existing process managers:

- **vs PM2**: Modern architecture, TypeScript native, plugin system, zero-downtime deployments
- **vs systemd**: Cross-platform, designed for Node.js, easy configuration
- **vs Docker**: Lighter weight, designed for development workflows

## Contributing

Please read our [Contributing Guide](./CONTRIBUTING.md) before submitting PRs.

## License

MIT © [Ersin Koc](https://github.com/ersin) and the OpenDaemon Organization
