import { describe, it, expect } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { detectInit, planStartup, type StartupOptions } from '../../packages/cli/src/startup.js';

const base: StartupOptions = {
  init: 'systemd', system: false, node: '/usr/bin/node', daemonScript: '/opt/od/daemon.js',
  workingDirectory: '/srv/app', home: '/home/me/.opendaemon', user: 'me',
};

describe('detectInit', () => {
  it('should pick the init system from the platform and marker files', () => {
    expect(detectInit('darwin')).toBe('launchd');
    expect(detectInit('linux', (p) => p === '/run/systemd/system')).toBe('systemd');
    expect(detectInit('linux', (p) => p === '/sbin/openrc-run')).toBe('openrc');
    expect(detectInit('linux', () => false)).toBeUndefined();
    expect(detectInit('win32')).toBeUndefined();
  });
});

describe('planStartup', () => {
  it('should generate a user systemd unit that runs the daemon in the foreground', () => {
    const plan = planStartup(base);
    expect(plan.file).toBe(join(homedir(), '.config/systemd/user/opendaemon.service'));
    expect(plan.content).toContain('ExecStart=/usr/bin/node /opt/od/daemon.js');
    expect(plan.content).toContain('WorkingDirectory=/srv/app');
    expect(plan.content).toContain('Environment=OPENDAEMON_HOME=/home/me/.opendaemon');
    expect(plan.content).toContain('WantedBy=default.target');
    expect(plan.content).toContain('TimeoutStopSec=90');
    expect(plan.content).not.toContain('User=');
    expect(plan.enable).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable --now opendaemon']);
    expect(plan.disable[0]).toBe('systemctl --user disable --now opendaemon');
  });

  it('should generate a system-wide unit that runs as the given user', () => {
    const plan = planStartup({ ...base, system: true });
    expect(plan.file).toBe('/etc/systemd/system/opendaemon.service');
    expect(plan.content).toContain('User=me');
    expect(plan.content).toContain('WantedBy=multi-user.target');
    expect(plan.enable[1]).toBe('systemctl enable --now opendaemon');
  });

  it('should quote paths with spaces or quotes for systemd', () => {
    const plan = planStartup({ ...base, node: 'C:\\Program Files\\node.exe', workingDirectory: '/srv/my "app"', home: '/home/a b' });
    expect(plan.content).toContain('ExecStart="C:\\\\Program Files\\\\node.exe" /opt/od/daemon.js');
    expect(plan.content).toContain('WorkingDirectory="/srv/my \\"app\\""');
    expect(plan.content).toContain('Environment="OPENDAEMON_HOME=/home/a b"');
  });

  it('should generate a launchd agent or daemon with escaped XML', () => {
    const agent = planStartup({ ...base, init: 'launchd', workingDirectory: '/srv/a&b' });
    expect(agent.file).toBe(join(homedir(), 'Library/LaunchAgents/dev.opendaemon.daemon.plist'));
    expect(agent.content).toContain('<string>/usr/bin/node</string><string>/opt/od/daemon.js</string>');
    expect(agent.content).toContain('<key>WorkingDirectory</key><string>/srv/a&amp;b</string>');
    expect(agent.content).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(agent.content).toContain('daemon.log');
    expect(agent.enable).toEqual([`launchctl load -w ${agent.file}`]);

    expect(planStartup({ ...base, init: 'launchd', system: true }).file).toBe('/Library/LaunchDaemons/dev.opendaemon.daemon.plist');
  });

  it('should generate an OpenRC script with shell-quoted values', () => {
    const plan = planStartup({ ...base, init: 'openrc', system: true, workingDirectory: "/srv/it's" });
    expect(plan.file).toBe('/etc/init.d/opendaemon');
    expect(plan.content.startsWith('#!/sbin/openrc-run\n')).toBe(true);
    expect(plan.content).toContain("directory='/srv/it'\\''s'");
    expect(plan.content).toContain("export OPENDAEMON_HOME='/home/me/.opendaemon'");
    expect(plan.content).toContain("command_user='me'");
    expect(plan.enable).toContain('rc-update add opendaemon default');
  });
});
