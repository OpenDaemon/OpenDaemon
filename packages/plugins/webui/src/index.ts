import type { Plugin, PluginContext } from '../../core/src/index.js';
import { Logger } from '../../core/src/index.js';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve, extname } from 'path';
import { fileURLToPath } from 'url';

// Note: In production build, this path needs to be adjusted
const publicDir = resolve(process.cwd(), 'packages', 'plugins', 'webui', 'src', 'public');

/**
 * WebUI Plugin - HTTP server and web interface
 */
export class WebuiPlugin implements Plugin {
  name = 'webui';
  version = '1.0.0';
  description = 'Web UI for OpenDaemon';
  priority = 20;

  private context?: PluginContext;
  private logger?: Logger;
  private server?: Server;
  private port = 7777;
  private auth?: { username: string; password: string };
  private sessionToken?: string;

  async install(context: PluginContext): Promise<void> {
    this.context = context;
    this.logger = context.logger;
    this.logger.info('WebUI plugin installed');
  }

  async onStart(context: PluginContext): Promise<void> {
    this.context = context;
    this.logger = context.logger;

    // Get config
    const config = context.pluginConfig as { port?: number; username?: string; password?: string } | undefined;
    if (config?.port) {
      this.port = config.port;
    }

    // Set up authentication if configured
    if (config?.username && config?.password) {
      this.auth = {
        username: config.username,
        password: config.password,
      };
      // Generate random session token
      this.sessionToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      this.logger.info('WebUI authentication enabled');
    }

    // Create HTTP server
    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    // Start server
    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, () => {
        this.logger!.info(`WebUI server listening on http://localhost:${this.port}`);
        resolve();
      });

      this.server!.on('error', (err) => {
        this.logger!.error('WebUI server error', undefined, err);
        reject(err);
      });
    });
  }

  async onStop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.logger!.info('WebUI server stopped');
          resolve();
        });
      });
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Check authentication if enabled
    if (this.auth && !this.isAuthenticated(req)) {
      if (url === '/api/login' && method === 'POST') {
        await this.handleLogin(req, res);
        return;
      }
      
      // Return 401 for API requests
      if (url.startsWith('/api/')) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
      
      // For root path, serve dashboard HTML (SPA will handle auth check)
      // For other HTML requests, serve login page
      if (url === '/' || url === '/index.html') {
        await this.handleStaticFile(req, res, url);
        return;
      }
      
      // Serve login page for other HTML requests
      await this.serveLoginPage(res);
      return;
    }

    // Handle logout
    if (url === '/api/logout' && method === 'POST') {
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // API routes
    if (url.startsWith('/api/')) {
      await this.handleApiRequest(req, res, url, method);
      return;
    }

    // Static files
    await this.handleStaticFile(req, res, url);
  }

  private isAuthenticated(req: IncomingMessage): boolean {
    const authHeader = req.headers.authorization;
    if (!authHeader) return false;

    // Check Bearer token
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      return token === this.sessionToken;
    }

    // Check Basic auth for single requests
    if (authHeader.startsWith('Basic ')) {
      const base64 = authHeader.substring(6);
      const decoded = Buffer.from(base64, 'base64').toString('utf-8');
      const [username, password] = decoded.split(':');
      return username === this.auth!.username && password === this.auth!.password;
    }

    return false;
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req);
      const { username, password } = JSON.parse(body);

      if (username === this.auth!.username && password === this.auth!.password) {
        res.writeHead(200);
        res.end(JSON.stringify({ 
          success: true, 
          token: this.sessionToken,
          message: 'Login successful'
        }));
      } else {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Invalid credentials' }));
      }
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  }

  private async serveLoginPage(res: ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenDaemon - Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0f172a, #1e293b);
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-box {
      background: #1e293b;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      width: 100%;
      max-width: 400px;
    }
    h1 {
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 8px;
      font-size: 28px;
    }
    .subtitle {
      color: #64748b;
      margin-bottom: 30px;
    }
    .input-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      color: #94a3b8;
      font-size: 14px;
    }
    input {
      width: 100%;
      padding: 12px;
      border: 1px solid #334155;
      border-radius: 6px;
      background: #0f172a;
      color: #e2e8f0;
      font-size: 16px;
      transition: border-color 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #3b82f6;
    }
    button {
      width: 100%;
      padding: 12px;
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    button:hover {
      opacity: 0.9;
    }
    .error {
      color: #ef4444;
      margin-top: 15px;
      font-size: 14px;
      display: none;
    }
    .logo {
      text-align: center;
      margin-bottom: 20px;
    }
    .logo-icon {
      font-size: 48px;
      margin-bottom: 10px;
    }
  </style>
</head>
<body>
  <div class="login-box">
    <div class="logo">
      <div class="logo-icon">⚡</div>
      <h1>OpenDaemon</h1>
      <p class="subtitle">Process Manager</p>
    </div>
    <form id="loginForm">
      <div class="input-group">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" required autocomplete="username">
      </div>
      <div class="input-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autocomplete="current-password">
      </div>
      <button type="submit">Sign In</button>
    </form>
    <div id="error" class="error"></div>
  </div>
  <script>
    console.log('Login page loaded');
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      console.log('Form submitted');
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      console.log('Username:', username);
      
      try {
        console.log('Sending fetch request...');
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        console.log('Response received:', res.status);
        
        const data = await res.json();
        console.log('Data:', data);
        
        if (data.success) {
          console.log('Login successful, saving token...');
          localStorage.setItem('od_token', data.token);
          console.log('Token saved, redirecting...');
          window.location.href = '/';
        } else {
          console.log('Login failed:', data.error);
          document.getElementById('error').style.display = 'block';
          document.getElementById('error').textContent = data.error || 'Login failed';
        }
      } catch (err) {
        console.error('Error:', err);
        document.getElementById('error').style.display = 'block';
        document.getElementById('error').textContent = 'Network error: ' + err.message;
      }
    });
  </script>
</body>
</html>`);
  }

  private async handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    method: string
  ): Promise<void> {
    res.setHeader('Content-Type', 'application/json');

    try {
      if (url === '/api/processes' && method === 'GET') {
        // Get process list from process manager
        const processManager = this.context!.getPlugin<{ getProcesses: () => unknown[] }>('process-manager');
        if (!processManager) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'Process manager not available' }));
          return;
        }

        const processes = processManager.getProcesses();
        res.writeHead(200);
        res.end(JSON.stringify(processes));
        return;
      }

      if (url === '/api/start' && method === 'POST') {
        const body = await this.readBody(req);
        const config = JSON.parse(body);
        
        // Start process via RPC
        this.context!.events.emit('webui:start', config);
        
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'Process start requested' }));
        return;
      }

      if (url.startsWith('/api/stop/') && method === 'POST') {
        const name = url.replace('/api/stop/', '');
        
        // Stop process via RPC
        this.context!.events.emit('webui:stop', { name });
        
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'Process stop requested' }));
        return;
      }

      if (url.startsWith('/api/delete/') && method === 'DELETE') {
        const name = url.replace('/api/delete/', '');
        
        // Delete process via RPC
        this.context!.events.emit('webui:delete', { name });
        
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'Process delete requested' }));
        return;
      }

      if (url === '/api/daemon' && method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'running',
          version: '1.0.0',
          uptime: process.uptime(),
        }));
        return;
      }

      // Unknown API endpoint
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      this.logger!.error('API error', undefined, err as Error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  private async handleStaticFile(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    // Default to index.html
    let filePath = url === '/' ? '/index.html' : url;
    
    // Security: prevent directory traversal
    if (filePath.includes('..')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Map to public directory
    const fullPath = resolve(publicDir, filePath.slice(1));

    if (!existsSync(fullPath)) {
      // Serve index.html for SPA routes
      const indexPath = resolve(publicDir, 'index.html');
      if (existsSync(indexPath)) {
        res.setHeader('Content-Type', 'text/html');
        res.writeHead(200);
        res.end(readFileSync(indexPath));
        return;
      }
      
      // Fallback: serve inline HTML if file not found
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      res.end(getFallbackHTML());
      return;
    }

    // Set content type
    const ext = extname(fullPath).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };

    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    res.writeHead(200);
    res.end(readFileSync(fullPath));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        resolve(body);
      });
      req.on('error', reject);
    });
  }

  private getFallbackHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenDaemon WebUI</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a; 
      color: #e2e8f0; 
      min-height: 100vh;
      padding: 20px;
    }
    h1 { 
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 20px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    .process-card {
      background: #1e293b;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
      border: 1px solid #334155;
    }
    .status-online { color: #10b981; }
    .status-offline { color: #ef4444; }
    button {
      background: #3b82f6;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      margin-right: 8px;
    }
    button:hover { background: #2563eb; }
    #loading { color: #64748b; }
    /* Login overlay styles */
    #loginOverlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: linear-gradient(135deg, #0f172a, #1e293b);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .login-box {
      background: #1e293b;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      width: 100%;
      max-width: 400px;
    }
    .logo {
      text-align: center;
      margin-bottom: 20px;
    }
    .logo-icon {
      font-size: 48px;
      margin-bottom: 10px;
    }
    .subtitle {
      color: #64748b;
      margin-bottom: 30px;
      text-align: center;
    }
    .input-group {
      margin-bottom: 20px;
    }
    .input-group label {
      display: block;
      margin-bottom: 8px;
      color: #94a3b8;
      font-size: 14px;
    }
    .input-group input {
      width: 100%;
      padding: 12px;
      border: 1px solid #334155;
      border-radius: 6px;
      background: #0f172a;
      color: #e2e8f0;
      font-size: 16px;
    }
    .input-group input:focus {
      outline: none;
      border-color: #3b82f6;
    }
    .login-box button {
      width: 100%;
      padding: 12px;
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
    }
    #loginError {
      color: #ef4444;
      margin-top: 15px;
      font-size: 14px;
      display: none;
      text-align: center;
    }
    #dashboardContent {
      display: none;
    }
  </style>
</head>
<body>
  <!-- Login Overlay -->
  <div id="loginOverlay">
    <div class="login-box">
      <div class="logo">
        <div class="logo-icon">&#9889;</div>
        <h1>OpenDaemon</h1>
        <p class="subtitle">Process Manager</p>
      </div>
      <form id="loginForm">
        <div class="input-group">
          <label for="username">Username</label>
          <input type="text" id="username" name="username" required autocomplete="username">
        </div>
        <div class="input-group">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required autocomplete="current-password">
        </div>
        <button type="submit">Sign In</button>
      </form>
      <div id="loginError"></div>
    </div>
  </div>

  <!-- Dashboard Content -->
  <div id="dashboardContent">
    <div style="text-align: right; margin-bottom: 20px;">
      <button onclick="logout()" style="background: #ef4444;">Logout</button>
    </div>
    <div class="container">
      <h1>OpenDaemon WebUI</h1>
      <div id="loading">Loading processes...</div>
      <div id="processes"></div>
    </div>
  </div>

  <script>
    // Check auth status and show appropriate view
    let token = localStorage.getItem('od_token');
    
    if (token) {
      showDashboard();
    } else {
      showLogin();
    }
    
    function showLogin() {
      document.getElementById('loginOverlay').style.display = 'flex';
      document.getElementById('dashboardContent').style.display = 'none';
    }
    
    function showDashboard() {
      document.getElementById('loginOverlay').style.display = 'none';
      document.getElementById('dashboardContent').style.display = 'block';
      loadProcesses();
      setInterval(loadProcesses, 5000);
    }
    
    // Login form handler
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const errorDiv = document.getElementById('loginError');
      
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        
        const data = await res.json();
        
        if (data.success) {
          token = data.token;
          localStorage.setItem('od_token', token);
          errorDiv.style.display = 'none';
          showDashboard();
        } else {
          errorDiv.style.display = 'block';
          errorDiv.textContent = data.error || 'Login failed';
        }
      } catch (err) {
        errorDiv.style.display = 'block';
        errorDiv.textContent = 'Network error: ' + err.message;
      }
    });
    
    async function apiFetch(url, options = {}) {
      const res = await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          'Authorization': 'Bearer ' + token
        }
      });
      if (res.status === 401) {
        localStorage.removeItem('od_token');
        token = null;
        showLogin();
        return null;
      }
      return res;
    }
    
    async function loadProcesses() {
      try {
        const res = await apiFetch('/api/processes');
        if (!res) return;
        const processes = await res.json();
        renderProcesses(processes);
      } catch (err) {
        document.getElementById('loading').textContent = 'Error: ' + err.message;
      }
    }
    
    function renderProcesses(processes) {
      document.getElementById('loading').style.display = 'none';
      const container = document.getElementById('processes');
      
      if (processes.length === 0) {
        container.innerHTML = '<p>No processes running</p>';
        return;
      }
      
      container.innerHTML = processes.map(p => 
        '<div class="process-card">' +
          '<h3>' + (p.config?.name || 'Unknown') + '</h3>' +
          '<p>Status: <span class="status-' + p.status + '">' + p.status + '</span></p>' +
          '<p>PID: ' + (p.pid || 'N/A') + ' | Mode: ' + (p.config?.mode || 'fork') + '</p>' +
          '<p>Restarts: ' + (p.restartCount || 0) + '</p>' +
          '<button onclick="stop(\'' + p.config?.name + '\')">Stop</button>' +
          '<button onclick="del(\'' + p.config?.name + '\')">Delete</button>' +
        '</div>'
      ).join('');
    }
    
    async function stop(name) {
      await apiFetch('/api/stop/' + name, { method: 'POST' });
      loadProcesses();
    }
    
    async function del(name) {
      if (!confirm('Delete ' + name + '?')) return;
      await apiFetch('/api/delete/' + name, { method: 'DELETE' });
      loadProcesses();
    }
    
    async function logout() {
      await apiFetch('/api/logout', { method: 'POST' });
      localStorage.removeItem('od_token');
      token = null;
      showLogin();
    }
  </script>
</body>
</html>`;
  }
}