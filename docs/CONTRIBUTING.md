# Contributing to OpenDaemon

Thank you for your interest in contributing to OpenDaemon! This document provides guidelines and instructions for contributing.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/opendaemon/opendaemon.git
cd opendaemon

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test
```

## Development Workflow

1. **Create a branch**: `git checkout -b feature/your-feature-name`
2. **Make your changes**: Follow the code style guidelines
3. **Write tests**: All changes must include tests
4. **Run tests**: Ensure all tests pass with `npm test`
5. **Check types**: Run `npm run typecheck`
6. **Lint your code**: Run `npm run lint`
7. **Commit**: Follow conventional commits format
8. **Push**: `git push origin feature/your-feature-name`
9. **Create PR**: Open a pull request with a clear description

## Code Style

- Use TypeScript with strict mode
- No `any` types allowed
- Maximum 50 lines per function
- Maximum 400 lines per file
- Use JSDoc for all public APIs
- Follow existing code patterns

## Testing

- All code must have 100% test coverage
- Write tests before implementation (TDD)
- Use Vitest for testing
- Mock system calls in unit tests
- Use real processes in integration tests

## Commit Messages

Follow conventional commits:

- `feat: add new feature`
- `fix: fix bug`
- `docs: update documentation`
- `test: add tests`
- `refactor: refactor code`
- `chore: update dependencies`

## Pull Request Process

1. Update documentation if needed
2. Add tests for new features
3. Ensure CI passes
4. Request review from maintainers
5. Address review feedback
6. Squash commits if requested

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn and grow
- Follow the project's values

## Questions?

- Open an issue for bugs or feature requests
- Join our Discord for discussions
- Check the documentation at https://opendaemon.dev

Thank you for contributing!
