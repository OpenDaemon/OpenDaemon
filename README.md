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
- **WebUI Dashboard** - Modern web interface with authentication
- **94.41% Test Coverage** - Comprehensive test suite
- **MIT Licensed** - Truly open source

## Quick Start

```bash
# Install globally
npm install -g opendaemon

# Start the daemon
od daemon start

# Start a process
od start app.js --name my-app

# List processes
od list

# View WebUI
open http://localhost:7777
```

## Configuration

Create `opendaemon.config.json`:

```json
{
  "plugins": {
    "webui": {
      "port": 7777,
      "username": "admin",
      "password": "your-password"
    }
  },
  "apps": [
    {
      "name": "api",
      "script": "./dist/api.js",
      "instances": 4,
      "healthCheck": {
        "type": "http",
        "url": "http://localhost:3000/health"
      }
    }
  ]
}
```

## Project Structure

```
opendaemon/
├── packages/
│   ├── core/          # Micro-kernel, event bus, state machine
│   ├── cli/           # Command-line interface
│   └── sdk/           # JavaScript/TypeScript SDK
├── tests/             # Unit, integration, and E2E tests
├── docs/              # Documentation
│   ├── architecture/  # SPECIFICATION.md, IMPLEMENTATION.md
│   └── CONTRIBUTING.md
├── examples/          # Example applications
├── CHANGELOG.md       # Release history
└── README.md         # This file
```

## Documentation

- [Architecture](./docs/architecture/) - System specification and implementation details
- [Contributing Guide](./docs/CONTRIBUTING.md) - How to contribute
- [Changelog](./CHANGELOG.md) - Release history
- [API Reference](https://opendaemon.dev/api)
- [Configuration Guide](https://opendaemon.dev/config)
- [CLI Reference](https://opendaemon.dev/cli)

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

## Why OpenDaemon?

OpenDaemon was created to address the limitations of existing process managers:

- **vs PM2**: Modern architecture, TypeScript native, plugin system, better security
- **vs systemd**: Cross-platform, designed for Node.js, easy configuration
- **vs Docker**: Lighter weight, designed for development workflows

## Community

- **Twitter/X**: [@ersinkoc](https://x.com/ersinkoc)
- **GitHub**: [github.com/ersinkoc](https://github.com/ersinkoc)
- **Website**: [opendaemon.dev](https://opendaemon.dev)
- **Issues**: [github.com/opendaemon/opendaemon/issues](https://github.com/opendaemon/opendaemon/issues)

## Contributing

Please read our [Contributing Guide](./docs/CONTRIBUTING.md) before submitting PRs.

## License

MIT © [Ersin KOÇ](https://github.com/ersinkoc) & Contributors

---

**Maintainer**: [Ersin KOÇ](https://x.com/ersinkoc)  
**Repository**: [github.com/opendaemon/opendaemon](https://github.com/opendaemon/opendaemon)  
**Website**: [opendaemon.dev](https://opendaemon.dev)
