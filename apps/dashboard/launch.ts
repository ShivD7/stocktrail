import { spawn } from 'node:child_process';
import { readConfig } from '../../packages/agent/src/config.js';
import {
  createDashboardDataSource,
  startDashboardServer,
  type DashboardDataSource,
  type DashboardServer,
} from './server.js';

export type DashboardLaunchDependencies = {
  readShop(directory: string): Promise<string | null>;
  createDataSource(directory: string, shop: string | null): DashboardDataSource;
  startServer(data: DashboardDataSource, options: { port: number }): Promise<DashboardServer>;
  openUrl(url: string): void;
};

const defaultDependencies: DashboardLaunchDependencies = {
  async readShop(directory) { return (await readConfig(directory)).shop; },
  createDataSource: createDashboardDataSource,
  startServer: (data, options) => startDashboardServer(data, options),
  openUrl: openDashboardUrl,
};

export function parseDashboardPort(value: string | undefined): number {
  if (value === undefined) return 4173;
  if (!/^\d+$/.test(value)) throw new Error('Dashboard port must be a whole number from 1 to 65535.');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Dashboard port must be a whole number from 1 to 65535.');
  }
  return port;
}

export function openDashboardUrl(url: string): void {
  const command = process.platform === 'win32' ? 'explorer.exe'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

export async function launchDashboard(
  directory: string,
  options: { port?: string; open?: boolean } = {},
  dependencies: DashboardLaunchDependencies = defaultDependencies,
): Promise<DashboardServer> {
  const port = parseDashboardPort(options.port);
  const shop = await dependencies.readShop(directory);
  const data = dependencies.createDataSource(directory, shop);
  const server = await dependencies.startServer(data, { port });
  if (options.open !== false) dependencies.openUrl(server.url);
  return server;
}

export function waitForDashboardShutdown(server: DashboardServer): Promise<void> {
  return new Promise((resolve, reject) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void server.close().then(resolve, reject);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}
