// Worker process example for OpenDaemon
// This simulates a background worker that processes jobs

console.log(`Worker started with PID ${process.pid}`);

let jobCount = 0;
let isRunning = true;

// Simulate job processing
function processJob() {
  if (!isRunning) return;
  
  jobCount++;
  console.log(`Processing job #${jobCount} at ${new Date().toISOString()}`);
  
  // Simulate work
  setTimeout(() => {
    console.log(`Job #${jobCount} completed`);
    
    // Process next job after random delay
    if (isRunning) {
      setTimeout(processJob, Math.random() * 5000 + 2000);
    }
  }, 1000);
}

// Start processing
processJob();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Worker received SIGTERM, finishing current job...');
  isRunning = false;
  
  // Wait for current job to finish
  setTimeout(() => {
    console.log('Worker shutting down gracefully');
    process.exit(0);
  }, 2000);
});

process.on('SIGINT', () => {
  console.log('Worker received SIGINT, shutting down immediately');
  isRunning = false;
  process.exit(0);
});

// Keep process alive
setInterval(() => {}, 1000);