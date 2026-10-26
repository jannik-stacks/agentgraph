export const networks = ['none', 'models', 'egress', 'open'] as const;
export type Network = (typeof networks)[number];

export const getHostReach = (running: Map<Network, number>, egress: RegExp[], host: string) => {
  const on = (network: Network) => (running.get(network) ?? 0) > 0;
  if (host === 'gateway.internal') return on('models') || on('egress') || on('open') ? 'gateway' : 'none';
  if (on('open') || (on('egress') && egress.some(pattern => pattern.test(host)))) return 'pass';
  return 'none';
};
