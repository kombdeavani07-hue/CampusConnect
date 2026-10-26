import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';

export function getWifiHost(interfaces = networkInterfaces(), override = process.env.CAMPUS_HOST) {
  const addresses = Object.entries(interfaces).flatMap(([name, rows]) =>
    (rows || []).filter(row => !row.internal &&
      (row.family === 'IPv4' || row.family === 4) && isIPv4(row.address) &&
      !row.address.startsWith('169.254.'))
      .map(row => ({ name, address: row.address })));
  if (override) {
    if (!addresses.some(row => row.address === override)) {
      throw new Error('CAMPUS_HOST must be an IPv4 address currently assigned to this laptop.');
    }
    return override;
  }
  const wifi = addresses.filter(row => /wi[\s-]?fi|wireless|wlan/i.test(row.name) &&
    !/virtual|loopback|vpn|vethernet|wi-fi direct/i.test(row.name));
  if (wifi.length === 1) return wifi[0].address;
  if (wifi.length > 1) throw new Error('Multiple Wi-Fi addresses are active. Set CAMPUS_HOST to the address you want to use.');
  throw new Error('No active Wi-Fi IPv4 address found. Connect to Wi-Fi, then run npm.cmd run dev again.');
}

export function getClientOrigin() {
  return 'http://' + getWifiHost() + ':5173';
}
