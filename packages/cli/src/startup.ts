import { homedir } from 'os';
import { resolve } from 'path';

export type InitSystem = 'systemd' | 'launchd' | 'openrc' | 'schtasks';

export interface StartupOptions {
  init: InitSystem;
  /** Install for the whole machine (root) instead of the current user */
  system: boolean;
  node: string;
  daemonScript: string;
  /** Where config files are discovered: the daemon is started here */
  workingDirectory: string;
  home: string;
  user?: string | undefined;
}

export interface StartupPlan {
  init: InitSystem;
  file: string;
  content: string;
  /** Commands to run after writing the file, in order */
  enable: string[];
  disable: string[];
}

const SERVICE = 'opendaemon';

export function detectInit(platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = () => false): InitSystem | undefined {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'win32') return 'schtasks';
  if (platform !== 'linux') return undefined;
  if (exists('/run/systemd/system')) return 'systemd';
  if (exists('/sbin/openrc-run')) return 'openrc';
  return undefined;
}

/**
 * Quote a value for a systemd ExecStart/Environment line
 */
function systemdQuote(value: string): string {
  return /^[A-Za-z0-9_./:=+,@%-]+$/.test(value) ? value : `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function planStartup(options: StartupOptions): StartupPlan {
  const { init, system, node, daemonScript, workingDirectory, home } = options;
  const userHome = homedir();

  if (init === 'systemd') {
    const content = [
      '[Unit]',
      'Description=OpenDaemon process manager',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${systemdQuote(node)} ${systemdQuote(daemonScript)}`,
      `WorkingDirectory=${systemdQuote(workingDirectory)}`,
      `Environment=${systemdQuote(`OPENDAEMON_HOME=${home}`)}`,
      ...(system && options.user ? [`User=${options.user}`] : []),
      'Restart=on-failure',
      'RestartSec=3',
      // The daemon stops managed apps level by level on SIGTERM; give it time before SIGKILL
      'TimeoutStopSec=90',
      '',
      '[Install]',
      `WantedBy=${system ? 'multi-user.target' : 'default.target'}`,
      '',
    ].join('\n');
    const scope = system ? '' : ' --user';
    return {
      init,
      file: system ? `/etc/systemd/system/${SERVICE}.service` : resolve(userHome, '.config/systemd/user', `${SERVICE}.service`),
      content,
      // a user unit only runs at boot when the user is allowed to linger without a login session
      enable: [`systemctl${scope} daemon-reload`, `systemctl${scope} enable --now ${SERVICE}`, ...(system ? [] : ['loginctl enable-linger "$USER"'])],
      disable: [`systemctl${scope} disable --now ${SERVICE}`, `systemctl${scope} daemon-reload`],
    };
  }

  if (init === 'launchd') {
    const label = 'dev.opendaemon.daemon';
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      `  <key>Label</key><string>${label}</string>`,
      '  <key>ProgramArguments</key>',
      `  <array><string>${xmlEscape(node)}</string><string>${xmlEscape(daemonScript)}</string></array>`,
      `  <key>WorkingDirectory</key><string>${xmlEscape(workingDirectory)}</string>`,
      `  <key>EnvironmentVariables</key><dict><key>OPENDAEMON_HOME</key><string>${xmlEscape(home)}</string></dict>`,
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
      '  <key>ExitTimeOut</key><integer>90</integer>',
      `  <key>StandardOutPath</key><string>${xmlEscape(resolve(home, 'daemon.log'))}</string>`,
      `  <key>StandardErrorPath</key><string>${xmlEscape(resolve(home, 'daemon.log'))}</string>`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
    const file = system ? `/Library/LaunchDaemons/${label}.plist` : resolve(userHome, 'Library/LaunchAgents', `${label}.plist`);
    return { init, file, content, enable: [`launchctl load -w ${file}`], disable: [`launchctl unload -w ${file}`] };
  }

  if (init === 'schtasks') {
    // The Task Scheduler cannot set an environment, so cmd.exe sets OPENDAEMON_HOME first.
    // /s strips the outer quotes of the command line.
    const command = `/d /s /c "set "OPENDAEMON_HOME=${home}" && "${node}" "${daemonScript}""`;
    const task = 'OpenDaemon';
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <RegistrationInfo><Description>OpenDaemon process manager</Description></RegistrationInfo>',
      '  <Triggers>',
      system ? '    <BootTrigger><Enabled>true</Enabled></BootTrigger>' : '    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>',
      '  </Triggers>',
      '  <Principals>',
      system
        ? '    <Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal>'
        : '    <Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>',
      '  </Principals>',
      '  <Settings>',
      '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
      '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
      '    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>',
      '    <Hidden>true</Hidden>',
      '  </Settings>',
      '  <Actions Context="Author">',
      '    <Exec>',
      '      <Command>cmd.exe</Command>',
      `      <Arguments>${xmlEscape(command)}</Arguments>`,
      `      <WorkingDirectory>${xmlEscape(workingDirectory)}</WorkingDirectory>`,
      '    </Exec>',
      '  </Actions>',
      '</Task>',
      '',
    ].join('\n');
    const file = resolve(home, 'opendaemon-task.xml');
    return {
      init,
      file,
      content,
      enable: [`schtasks /Create /TN ${task} /XML "${file}" /F`, `schtasks /Run /TN ${task}`],
      disable: [`schtasks /End /TN ${task}`, `schtasks /Delete /TN ${task} /F`],
    };
  }

  const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const content = [
    '#!/sbin/openrc-run',
    'description="OpenDaemon process manager"',
    `command=${shellQuote(node)}`,
    `command_args=${shellQuote(daemonScript)}`,
    'command_background=true',
    `directory=${shellQuote(workingDirectory)}`,
    `pidfile="/run/${SERVICE}.pid"`,
    `export OPENDAEMON_HOME=${shellQuote(home)}`,
    ...(options.user ? [`command_user=${shellQuote(options.user)}`] : []),
    'retry="SIGTERM/90/SIGKILL/5"',
    '',
    'depend() {',
    '  need net',
    '}',
    '',
  ].join('\n');
  return {
    init,
    file: `/etc/init.d/${SERVICE}`,
    content,
    enable: [`chmod +x /etc/init.d/${SERVICE}`, `rc-update add ${SERVICE} default`, `rc-service ${SERVICE} start`],
    disable: [`rc-service ${SERVICE} stop`, `rc-update del ${SERVICE} default`],
  };
}
