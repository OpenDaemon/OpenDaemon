# OpenDaemon Examples

This directory contains example applications and configurations for OpenDaemon.

## Files

- `simple-server.js` - Basic HTTP server with graceful shutdown
- `worker.js` - Background worker process example
- `opendaemon.config.ts` - TypeScript configuration example

## Usage

### 1. Start a Simple Process

```bash
# Start the example server
node packages/cli/dist/cli.js start examples/simple-server.js

# Test the server
curl http://localhost:3000
```

### 2. Start with Configuration

```bash
# Start all processes defined in config
node packages/cli/dist/cli.js start examples/opendaemon.config.ts

# List running processes
node packages/cli/dist/cli.js list

# Check status
node packages/cli/dist/cli.js status
```

### 3. Manage Processes

```bash
# Stop a process
node packages/cli/dist/cli.js stop api-server

# Restart a process
node packages/cli/dist/cli.js restart api-server

# Delete a process
node packages/cli/dist/cli.js delete api-server
```

### 4. Daemon Mode

```bash
# Start the daemon
node packages/cli/dist/cli.js daemon start

# Check daemon status
node packages/cli/dist/cli.js daemon status

# Stop the daemon
node packages/cli/dist/cli.js daemon stop
```

## Configuration Options

See `opendaemon.config.ts` for a complete example including:

- Multiple applications
- Cluster mode configuration
- Health checks
- Environment variables
- Watch configuration
- Logging settings
- Plugin configuration

## Testing Examples

### Test the Server
```bash
# Terminal 1: Start server
node examples/simple-server.js

# Terminal 2: Test endpoints
curl http://localhost:3000
curl http://localhost:3000/health
```

### Test the Worker
```bash
# Start worker
node examples/worker.js

# Watch logs (worker processes jobs every 2-7 seconds)
# Press Ctrl+C to stop
```

## Notes

- These examples use mock data for demonstration
- The actual daemon implementation connects via IPC
- Health checks require the server to be running
- Process names must be unique