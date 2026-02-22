# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-02-22

### Added
- Initial release of OpenDaemon
- Complete process management system with daemon architecture
- CLI tool (`od` command) for managing processes
- WebUI with authentication support (username/password)
- Multi-platform support (Windows, Linux, macOS)
- IPC communication via TCP (Windows) and Unix sockets (Linux/macOS)
- Process monitoring with automatic restarts
- Health checks for processes
- Configuration file support (JSON, YAML, TypeScript)
- Plugin system with 3 core plugins:
  - Config Manager Plugin
  - Process Manager Plugin
  - WebUI Plugin
- 579 passing tests with 94.41% code coverage
- Full TypeScript support with type definitions
- Zero runtime dependencies
- Comprehensive documentation

### Features
- **Daemon Mode**: Run as background service
- **Process Management**: Start, stop, restart, delete processes
- **Web Dashboard**: Modern dark-themed web interface
- **Authentication**: Secure login with Bearer tokens
- **CLI Interface**: Full-featured command line interface
- **Logging**: Comprehensive logging system
- **Auto-restart**: Automatic process restart on failure
- **Health Checks**: HTTP health check support
- **Cluster Mode**: Multi-instance process support
- **Environment Variables**: Per-process environment configuration

### Security
- Authentication required for WebUI access
- Bearer token-based API authentication
- Basic Auth support for API endpoints
- Secure session management

### Documentation
- Complete API documentation
- Architecture documentation
- Contributing guidelines
- Task and roadmap documentation

## [0.1.0] - 2026-02-20

### Added
- Project initialization
- Basic kernel architecture
- Plugin system foundation
- Initial test suite

---

**Maintainer**: [Ersin KOÇ](https://x.com/ersinkoc)  
**GitHub**: [github.com/ersinkoc](https://github.com/ersinkoc)  
**Repository**: [github.com/opendaemon/opendaemon](https://github.com/opendaemon/opendaemon)  
**Website**: [opendaemon.dev](https://opendaemon.dev)
